import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { closeDb, openDb } from "../db.js";
import { listRecentUsage, recordUsageEvent, summarizeUsage } from "./events.js";

before(() => {
  const dir = mkdtempSync(join(tmpdir(), "usage-store-test-"));
  process.env.SQLITE_PATH = join(dir, "usage.sqlite");
  openDb();
  (globalThis as { __usageTestDir?: string }).__usageTestDir = dir;
});

after(() => {
  closeDb();
  const dir = (globalThis as { __usageTestDir?: string }).__usageTestDir;
  if (dir) rmSync(dir, { recursive: true, force: true });
  delete process.env.SQLITE_PATH;
});

describe("usage store", () => {
  it("records chat and tool events and sanitizes bad numbers", () => {
    const chat = recordUsageEvent({
      kind: "chat",
      sessionId: "s1",
      providerId: "default",
      model: "gpt-4o-mini",
      inputTokens: 120,
      outputTokens: 45,
      toolCalls: 2,
      durationMs: 1500,
    });
    assert.ok(chat?.id);
    assert.equal(chat?.status, "ok");

    const bad = recordUsageEvent({ kind: "tool", inputTokens: Number.NaN, outputTokens: -5 });
    assert.equal(bad?.inputTokens, 0);
    assert.equal(bad?.outputTokens, 0);

    const invalid = recordUsageEvent({ kind: "nope" } as unknown as { kind: "chat" });
    assert.equal(invalid, null);
  });

  it("summarizes totals, per-model and per-tool breakdowns", () => {
    recordUsageEvent({
      kind: "tool",
      toolKind: "sql",
      toolName: "SQL 问数 · 运营库",
      durationMs: 300,
      status: "ok",
    });
    recordUsageEvent({
      kind: "tool",
      toolKind: "mcp",
      toolName: "crm/get_contact",
      durationMs: 120,
      status: "error",
    });

    const summary = summarizeUsage(Date.now() - 60_000, Date.now() + 60_000);
    assert.equal(summary.totals.events, 4);
    assert.equal(summary.totals.chatTurns, 1);
    // chat 行的 tool_calls 仅为元信息，不计入总量；总量只统计 kind='tool' 的事件。
    assert.equal(summary.totals.toolCalls, 3);
    assert.equal(summary.totals.inputTokens, 120);
    assert.equal(summary.totals.outputTokens, 45);
    assert.equal(summary.totals.totalTokens, 165);
    assert.deepEqual(
      summary.byModel.map((entry) => entry.model),
      ["gpt-4o-mini"],
    );
    const sql = summary.byTool.find((entry) => entry.toolName === "SQL 问数 · 运营库");
    assert.equal(sql?.calls, 1);
    assert.equal(sql?.errors, 0);
    const mcp = summary.byTool.find((entry) => entry.toolName === "crm/get_contact");
    assert.equal(mcp?.calls, 1);
    assert.equal(mcp?.errors, 1);
    assert.ok(summary.daily.length >= 1);
  });

  it("lists recent events newest-first with a clamped limit", () => {
    const recent = listRecentUsage(2);
    assert.equal(recent.length, 2);
    assert.ok((recent[0]?.createdAt ?? 0) >= (recent[1]?.createdAt ?? 0));
  });
});
