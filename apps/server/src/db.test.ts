import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  addMessage,
  closeDb,
  createSession,
  deleteMessage,
  deleteSession,
  getSession,
  listSessions,
  openDb,
  renameSession,
  updateMessage,
} from "./db.js";

describe("sqlite chat storage", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "open-agent-tools-sqlite-"));
    process.env.SQLITE_PATH = join(dir, "test.sqlite");
    closeDb();
    openDb();
  });

  afterEach(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SQLITE_PATH;
  });

  it("creates and lists sessions", () => {
    const a = createSession({ title: "A" });
    const b = createSession({ title: "B" });
    const listed = listSessions();
    assert.equal(listed.length, 2);
    assert.ok(listed.some((s) => s.id === a.id));
    assert.ok(listed.some((s) => s.id === b.id));
  });

  it("stores messages and auto-titles from first user message", () => {
    const session = createSession();
    const msg = addMessage(session.id, {
      role: "user",
      content: "Hello from the first message that is quite long",
    });
    assert.ok(msg);
    const loaded = getSession(session.id);
    assert.ok(loaded);
    assert.equal(loaded.messages.length, 1);
    assert.equal(loaded.messages[0]?.content, "Hello from the first message that is quite long");
    assert.equal(loaded.title, "Hello from the first message tha…");
  });

  it("updates assistant message content and status", () => {
    const session = createSession();
    const assistant = addMessage(session.id, {
      role: "assistant",
      content: "",
      status: "streaming",
    });
    assert.ok(assistant);
    updateMessage(assistant.id, { content: "hi", status: "complete" });
    const loaded = getSession(session.id);
    assert.equal(loaded?.messages[0]?.content, "hi");
    assert.equal(loaded?.messages[0]?.status, "complete");
  });

  it("renames and deletes sessions with cascade", () => {
    const session = createSession();
    addMessage(session.id, { role: "user", content: "x" });
    const renamed = renameSession(session.id, "Renamed");
    assert.equal(renamed?.title, "Renamed");
    assert.equal(deleteSession(session.id), true);
    assert.equal(getSession(session.id), null);
  });

  it("deletes individual messages", () => {
    const session = createSession();
    const msg = addMessage(session.id, { role: "user", content: "bye" });
    assert.ok(msg);
    assert.equal(deleteMessage(msg.id), true);
    assert.equal(getSession(session.id)?.messages.length, 0);
  });

  it("migrates legacy messages table missing tool columns", () => {
    closeDb();
    const path = process.env.SQLITE_PATH!;
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      DROP TABLE IF EXISTS messages;
      DROP TABLE IF EXISTS sessions;
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT 'New chat',
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        status TEXT,
        position INTEGER NOT NULL
      );
      INSERT INTO sessions (id, title, updated_at) VALUES ('s1', 'Legacy', 1);
      INSERT INTO messages (id, session_id, role, content, created_at, status, position)
      VALUES ('m1', 's1', 'user', 'hi', 1, 'complete', 0);
    `);
    legacy.close();

    openDb();
    const session = getSession("s1");
    assert.ok(session);
    assert.equal(session.messages.length, 1);
    assert.equal(session.messages[0]?.content, "hi");

    const toolMsg = addMessage("s1", {
      role: "tool",
      content: "result",
      tool_call_id: "call_1",
      tool_name: "get_financial_reports",
    });
    assert.ok(toolMsg);
    assert.equal(toolMsg.tool_call_id, "call_1");
    assert.equal(toolMsg.tool_name, "get_financial_reports");

    const reloaded = getSession("s1");
    assert.equal(reloaded?.messages[1]?.tool_call_id, "call_1");
    assert.equal(reloaded?.messages[1]?.tool_name, "get_financial_reports");
  });
});
