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

  it("returns the existing row when the same message id is inserted again", () => {
    const session = createSession();
    const first = addMessage(session.id, {
      id: "msg-user-1",
      role: "user",
      content: "original",
      status: "complete",
    });
    assert.ok(first);
    const second = addMessage(session.id, {
      id: "msg-user-1",
      role: "user",
      content: "rewritten",
      status: "error",
    });
    assert.ok(second);
    assert.equal(second.content, "original");
    assert.equal(second.status, "complete");
    const loaded = getSession(session.id);
    assert.equal(loaded?.messages.length, 1);
    assert.equal(loaded?.messages[0]?.content, "original");
  });

  it("rejects a reused message id that belongs to another session", () => {
    const first = createSession();
    const second = createSession();
    const message = addMessage(first.id, { id: "shared-id", role: "user", content: "owned" });
    assert.ok(message);
    assert.equal(
      addMessage(second.id, { id: "shared-id", role: "user", content: "stolen" }),
      null,
    );
    assert.equal(getSession(second.id)?.messages.length, 0);
    assert.equal(getSession(first.id)?.messages[0]?.content, "owned");
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

  it("adds schema_name to legacy schema source tables", () => {
    closeDb();
    const path = process.env.SQLITE_PATH!;
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      DROP TABLE IF EXISTS schema_sources;
      CREATE TABLE schema_sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        connector TEXT NOT NULL DEFAULT 'mysql',
        connection_url_enc TEXT NOT NULL,
        database_name TEXT,
        table_filter_json TEXT NOT NULL DEFAULT '[]',
        semantic_profile TEXT NOT NULL DEFAULT 'generic',
        enabled INTEGER NOT NULL DEFAULT 1,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    legacy.close();

    const migrated = openDb();
    const columns = migrated.prepare(`PRAGMA table_info(schema_sources)`).all() as Array<{
      name: string;
    }>;
    assert.ok(columns.some((column) => column.name === "schema_name"));
  });

  it("migrates legacy usage without changing tokens or resetting request counts on reopen", () => {
    closeDb();
    const legacy = new DatabaseSync(process.env.SQLITE_PATH!);
    legacy.exec(`
      DROP TABLE usage_events;
      CREATE TABLE usage_events (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        session_id TEXT,
        provider_id TEXT,
        model TEXT,
        tool_kind TEXT,
        tool_name TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'ok',
        created_at INTEGER NOT NULL
      );
      INSERT INTO usage_events (id, kind, input_tokens, output_tokens, created_at)
        VALUES ('legacy-chat', 'chat', 120, 25, 1), ('legacy-tool', 'tool', 0, 0, 2);
    `);
    legacy.close();

    const migrated = openDb();
    const rows = migrated
      .prepare(
        `
      SELECT id, source, requests, workspace_id, input_tokens, output_tokens
      FROM usage_events ORDER BY id
    `,
      )
      .all();
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [
        {
          id: "legacy-chat",
          source: "web_chat",
          requests: 1,
          workspace_id: "default",
          input_tokens: 120,
          output_tokens: 25,
        },
        {
          id: "legacy-tool",
          source: "web_chat",
          requests: 0,
          workspace_id: "default",
          input_tokens: 0,
          output_tokens: 0,
        },
      ],
    );
    migrated.prepare("UPDATE usage_events SET requests = 3 WHERE id = ?").run("legacy-chat");
    closeDb();
    assert.equal(
      openDb().prepare("SELECT requests FROM usage_events WHERE id = ?").get("legacy-chat")
        ?.requests,
      3,
    );
  });
});
