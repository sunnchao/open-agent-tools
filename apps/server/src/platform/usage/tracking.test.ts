import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { closeDb, openDb } from "../db.js";
import { listRecentUsage, summarizeUsage } from "./events.js";
import {
  currentUsage,
  currentUsageModels,
  recordToolCall,
  trackLlmRequest,
  trackUsage,
  type UsageModelDetail,
  type UsageSnapshot,
} from "./tracking.js";

let dir: string;
const previousPath = process.env.SQLITE_PATH;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "usage-tracking-test-"));
  process.env.SQLITE_PATH = join(dir, "usage.sqlite");
});
beforeEach(() => openDb().exec("DELETE FROM usage_events"));
after(() => {
  closeDb();
  if (previousPath === undefined) delete process.env.SQLITE_PATH;
  else process.env.SQLITE_PATH = previousPath;
  rmSync(dir, { recursive: true, force: true });
});

const complete = (inputTokens: number, outputTokens: number) => async () => ({
  tokenUsage: { inputTokens, outputTokens },
});

describe("request usage tracking", () => {
  it("includes nested SQL usage in the turn display and records each model only once", async () => {
    const snapshots: UsageSnapshot[] = [];
    await trackUsage(
      {
        source: "web_chat",
        workspaceId: "team-a",
        sessionId: "s1",
        onUsage: (usage) => snapshots.push(usage),
      },
      async () => {
        await trackLlmRequest("chat-provider", "chat-model", complete(100, 20));
        await trackUsage({ source: "sql_query" }, async () => {
          await trackLlmRequest("sql-provider", "sql-model", complete(200, 30));
          assert.equal(currentUsage().totalTokens, 230);
        });
        recordToolCall();
        await trackLlmRequest("chat-provider", "chat-model", complete(50, 10));
        assert.deepEqual(currentUsage(), {
          requests: 3,
          inputTokens: 350,
          outputTokens: 60,
          totalTokens: 410,
          toolCalls: 1,
          toolErrors: 0,
        });
      },
    );
    assert.equal(snapshots.at(-1)?.totalTokens, 410);
    const events = listRecentUsage();
    assert.equal(events.length, 2);
    assert.ok(events.every((event) => event.workspaceId === "team-a" && event.sessionId === "s1"));
    assert.equal(events.find((event) => event.source === "web_chat")?.requests, 2);
    const summary = summarizeUsage();
    assert.equal(summary.totals.chatTurns, 1);
    assert.equal(summary.totals.requests, 3);
    assert.equal(summary.totals.totalTokens, 410);
    assert.equal(summary.byModel.find((entry) => entry.model === "sql-model")?.inputTokens, 200);
    assert.deepEqual(summary.bySource.map((entry) => entry.source).sort(), [
      "sql_query",
      "web_chat",
    ]);
  });

  it("snapshots per-model usage across nested scopes", async () => {
    let snapshot: UsageModelDetail[] = [];
    await trackUsage(
      {
        source: "web_chat",
        onUsage: (_usage, models) => {
          snapshot = models;
        },
      },
      async () => {
        await trackLlmRequest("chat-provider", "chat-model", complete(100, 20));
        await trackUsage({ source: "sql_query" }, async () => {
          await trackLlmRequest("sql-provider", "sql-model", complete(200, 30));
          // 嵌套链路复用同一模型时，明细按模型合并而不是按链路拆分。
          await trackLlmRequest("chat-provider", "chat-model", complete(50, 10));
        });
        // 耗时随机器波动，断言前归零。
        const inside = currentUsageModels().map((entry) => ({ ...entry, durationMs: 0 }));
        assert.deepEqual(inside, [
          {
            providerId: "chat-provider",
            model: "chat-model",
            requests: 2,
            inputTokens: 150,
            outputTokens: 30,
            totalTokens: 180,
            durationMs: 0,
            failed: false,
          },
          {
            providerId: "sql-provider",
            model: "sql-model",
            requests: 1,
            inputTokens: 200,
            outputTokens: 30,
            totalTokens: 230,
            durationMs: 0,
            failed: false,
          },
        ]);
      },
    );
    // 作用域结束后仍保留最后一次发布的快照。
    assert.equal(snapshot.length, 2);
    assert.deepEqual(currentUsageModels(), []);
  });

  it("counts requests without usage metadata and preserves successful tokens on later failure", async () => {
    await assert.rejects(
      trackUsage({ source: "app_chat" }, async () => {
        await trackLlmRequest("p", "m", complete(10, 5));
        await trackLlmRequest("p", "m", async () => ({}));
        await trackLlmRequest("p", "m", async () => {
          throw new Error("provider failed");
        });
      }),
      /provider failed/,
    );
    const event = listRecentUsage()[0]!;
    assert.equal(event.requests, 3);
    assert.equal(event.inputTokens + event.outputTokens, 15);
    assert.equal(event.status, "error");
    assert.equal(event.source, "app_chat");
  });

  it("does not mix simultaneous requests from different workspaces", async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const second = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    await Promise.all([
      trackUsage({ source: "web_chat", workspaceId: "a" }, async () => {
        releaseFirst();
        await second;
        await trackLlmRequest("p", "m", complete(10, 1));
      }),
      trackUsage({ source: "sql_query", workspaceId: "b" }, async () => {
        await first;
        await trackLlmRequest("p", "m", complete(20, 2));
        releaseSecond();
      }),
    ]);
    assert.equal(summarizeUsage(undefined, undefined, "a").totals.totalTokens, 11);
    assert.equal(summarizeUsage(undefined, undefined, "b").totals.totalTokens, 22);
  });
});
