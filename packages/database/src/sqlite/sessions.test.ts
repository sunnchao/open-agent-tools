import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { SqliteSessionStore, sqliteTableColumns } from "./sessions.js";

function fixture(t: TestContext) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'New chat', updated_at INTEGER NOT NULL);
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT,
      position INTEGER NOT NULL, tool_call_id TEXT, tool_name TEXT
    );
    INSERT INTO sessions VALUES ('s1', 'New chat', 1), ('s2', 'Custom', 2);
  `);
  const store = new SqliteSessionStore<
    "user" | "assistant" | "tool",
    "complete" | "streaming" | "error" | "stopped"
  >(db, "complete");
  return { db, store };
}

test("table column helper reads existing schemas and rejects unsafe identifiers", (t) => {
  const { db } = fixture(t);
  assert.deepEqual(
    [...sqliteTableColumns(db, "messages")],
    [
      "id",
      "session_id",
      "role",
      "content",
      "created_at",
      "status",
      "position",
      "tool_call_id",
      "tool_name",
    ],
  );
  assert.deepEqual([...sqliteTableColumns(db, "missing")], []);
  assert.throws(
    () => sqliteTableColumns(db, "messages; DROP TABLE messages"),
    /invalid SQLite table name/,
  );
});

test("message replay batches requested session IDs and preserves position and legacy null fields", (t) => {
  const { db, store } = fixture(t);
  db.prepare(`INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "later",
    "s1",
    "tool",
    "later position",
    1,
    "stopped",
    9,
    "call",
    "tool",
  );
  db.prepare(`INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "first",
    "s1",
    "user",
    "first position",
    99,
    null,
    0,
    "",
    null,
  );
  store.addMessage("s2", { id: "private", role: "user", content: "other session" });
  db.prepare("INSERT INTO sessions VALUES ('last', 'Last batch', 0)").run();
  store.addMessage("last", { id: "last-message", role: "user", content: "after batch boundary" });
  const ids = ["s1", ...Array.from({ length: 501 }, (_, i) => `missing-${i}`), "last", "s1"];
  const prepares = t.mock.method(db, "prepare");
  const messages = store.messagesFor(ids);
  assert.equal(prepares.mock.callCount(), 2);
  assert.equal(messages.size, 503);
  assert.equal(messages.has("s2"), false);
  assert.deepEqual(messages.get("missing-0"), []);
  assert.equal(messages.get("last")?.[0]?.content, "after batch boundary");
  assert.deepEqual(messages.get("s1"), [
    { id: "first", role: "user", content: "first position", createdAt: 99 },
    {
      id: "later",
      role: "tool",
      content: "later position",
      createdAt: 1,
      status: "stopped",
      tool_call_id: "call",
      tool_name: "tool",
    },
  ]);
  prepares.mock.resetCalls();
  assert.deepEqual(store.messagesFor([]), new Map());
  assert.equal(prepares.mock.callCount(), 0);
});

test("insertion policies preserve strict duplicate errors and safe idempotent replay", (t) => {
  const { db, store } = fixture(t);
  const first = store.addMessage("s1", {
    id: "message",
    role: "user",
    content: "original",
    createdAt: 3,
  });
  assert.ok(first);
  assert.throws(
    () => store.addMessage("s1", { id: "message", role: "user", content: "replacement" }),
    /UNIQUE/,
  );
  assert.deepEqual(
    store.addMessage(
      "s1",
      { id: "message", role: "user", content: "replacement", status: "error" },
      { returnExisting: true },
    ),
    first,
  );
  assert.equal(
    store.addMessage(
      "s2",
      { id: "message", role: "user", content: "foreign" },
      { returnExisting: true },
    ),
    null,
  );
  assert.equal(
    store.addMessage(
      "s1",
      { id: "message", role: "assistant", content: "different role" },
      { returnExisting: true },
    ),
    null,
  );
  db.prepare("UPDATE messages SET status = NULL WHERE id = ?").run("message");
  assert.equal(
    store.addMessage(
      "s1",
      { id: "message", role: "user", content: "retry" },
      { returnExisting: true },
    )?.status,
    "complete",
  );
  assert.equal(store.addMessage("missing", { role: "user", content: "missing" }), null);
  assert.equal(store.messagesFor(["s1"]).get("s1")?.length, 1);
});

test("titles preserve trimming, newline replacement, empty fallback and 32-character truncation", (t) => {
  const { db, store } = fixture(t);
  for (const [i, content, expected] of [
    [0, "  first\nsecond  ", "first second"],
    [1, "  \n ", "New chat"],
    [2, "x".repeat(32), "x".repeat(32)],
    [3, "x".repeat(33), `${"x".repeat(32)}…`],
  ] as const) {
    const id = `title-${i}`;
    db.prepare("INSERT INTO sessions VALUES (?, 'New chat', 0)").run(id);
    store.addMessage(id, { role: "assistant", content: "assistant cannot set title" });
    store.addMessage(id, { role: "user", content });
    assert.equal(
      (db.prepare("SELECT title FROM sessions WHERE id = ?").get(id) as { title: string }).title,
      expected,
    );
  }
  store.addMessage("s2", { role: "user", content: "does not replace custom title" });
  assert.equal(
    (db.prepare("SELECT title FROM sessions WHERE id = 's2'").get() as { title: string }).title,
    "Custom",
  );
});

test("updates retain tool metadata in storage and use the current time for session activity", (t) => {
  const { db, store } = fixture(t);
  const message = store.addMessage("s1", {
    role: "tool",
    content: "",
    createdAt: 3,
    status: "streaming",
    tool_call_id: "call",
    tool_name: "search",
  });
  assert.ok(message);
  t.mock.method(Date, "now", () => 50);
  assert.deepEqual(store.updateMessage(message.id, { content: "result", status: "stopped" }), {
    id: message.id,
    role: "tool",
    content: "result",
    createdAt: 3,
    status: "stopped",
  });
  assert.equal(store.messagesFor(["s1"]).get("s1")?.[0]?.tool_call_id, "call");
  assert.equal(
    (db.prepare("SELECT updated_at FROM sessions WHERE id = 's1'").get() as { updated_at: number })
      .updated_at,
    50,
  );
  assert.equal(store.updateMessage("missing", {}), null);
  assert.equal(store.deleteMessage("missing"), false);
  assert.equal(store.deleteMessage(message.id), true);
  assert.equal(store.renameSession("missing", "none"), false);
  assert.equal(store.renameSession("s1", "renamed"), true);
  store.addMessage("s1", { role: "user", content: "new" });
  assert.equal(store.deleteSession("s1"), true);
  assert.equal(store.deleteSession("s1"), false);
  assert.equal(
    (
      db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = 's1'").get() as {
        n: number;
      }
    ).n,
    0,
  );
});
