import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { addMessage, closeDb, createSession, openDb } from "../../platform/db.js";
import { getSummary, upsertSummary } from "./store.js";
import { loadSessionHistory } from "./history.js";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memory-history-"));
  openDb(join(dir, "chat.sqlite"));
});

afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("loadSessionHistory", () => {
  it("returns completed turns in order and skips tool rows", () => {
    createSession({ id: "s1" });
    addMessage("s1", { role: "user", content: "问题一", status: "complete" });
    addMessage("s1", { role: "assistant", content: "回答一", status: "complete" });
    addMessage("s1", { role: "tool", content: "{\"ok\":true}", status: "complete" });
    addMessage("s1", { role: "user", content: "问题二", status: "complete" });
    addMessage("s1", { role: "assistant", content: "回答二", status: "complete" });

    const history = loadSessionHistory("s1");
    assert.deepEqual(
      history.turns.map((turn) => turn.content),
      ["问题一", "回答一", "问题二", "回答二"],
    );
    assert.equal(history.omittedTurns, 0);
  });

  it("drops streaming rows and empty content", () => {
    createSession({ id: "s2" });
    addMessage("s2", { role: "user", content: "完整问题", status: "complete" });
    addMessage("s2", { role: "assistant", content: "半截", status: "streaming" });
    addMessage("s2", { role: "user", content: "   ", status: "complete" });

    const history = loadSessionHistory("s2");
    assert.deepEqual(history.turns.map((turn) => turn.content), ["完整问题"]);
  });

  it("keeps the newest turns when over the window and reports omissions", () => {
    createSession({ id: "s3" });
    for (let index = 1; index <= 5; index += 1) {
      addMessage("s3", { role: "user", content: `问题${index}`, status: "complete" });
      addMessage("s3", { role: "assistant", content: `回答${index}`, status: "complete" });
    }
    const history = loadSessionHistory("s3", { turns: 2 });
    assert.deepEqual(
      history.turns.map((turn) => turn.content),
      ["问题4", "回答4", "问题5", "回答5"],
    );
    assert.equal(history.omittedTurns, 3);
  });

  it("excludes messages the caller already sent", () => {
    createSession({ id: "s4" });
    addMessage("s4", { id: "m1", role: "user", content: "旧问题", status: "complete" });
    addMessage("s4", { id: "m2", role: "assistant", content: "旧回答", status: "complete" });

    const history = loadSessionHistory("s4", { excludeMessageIds: ["m1", "m2"] });
    assert.deepEqual(history.turns, []);
  });

  it("surfaces the stored summary", () => {
    createSession({ id: "s5" });
    upsertSummary({ sessionId: "s5", summary: "用户在做记忆模块", coveredThroughPosition: 12 });
    assert.equal(loadSessionHistory("s5").summary, "用户在做记忆模块");
    assert.equal(getSummary("s5")?.coveredThroughPosition, 12);
  });
});
