import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { addMessage, addSessionUsage, closeDb, createSession, getSession, openDb } from "./db.ts";

/** 用临时 SQLITE_PATH 隔离单例数据库，测试结束清理。 */
async function withTempDb<T>(fn: (path: string) => Promise<T> | T): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "cli-db-"));
  const path = join(dir, "test.sqlite");
  process.env.SQLITE_PATH = path;
  try {
    return await fn(path);
  } finally {
    closeDb();
    delete process.env.SQLITE_PATH;
    await rm(dir, { recursive: true, force: true });
  }
}

it("addSessionUsage 累加会话 token 用量并可回读", async () => {
  await withTempDb(() => {
    openDb();
    const session = createSession();
    assert.deepEqual(session.usage, { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 });

    addSessionUsage(session.id, { inputTokens: 100, outputTokens: 50, reasoningTokens: 10 });
    addSessionUsage(session.id, { inputTokens: 200, outputTokens: 30, reasoningTokens: 5 });

    const loaded = getSession(session.id);
    assert.ok(loaded);
    assert.deepEqual(loaded.usage, { inputTokens: 300, outputTokens: 80, reasoningTokens: 15 });
  });
});

it("reasoning 角色消息可落库并按顺序回读", async () => {
  await withTempDb(() => {
    openDb();
    const session = createSession();
    addMessage(session.id, { role: "user", content: "hi" });
    addMessage(session.id, { role: "reasoning", content: "先分析需求" });
    addMessage(session.id, { role: "assistant", content: "好的" });

    const loaded = getSession(session.id);
    assert.ok(loaded);
    assert.deepEqual(
      loaded.messages.map((m) => [m.role, m.content]),
      [
        ["user", "hi"],
        ["reasoning", "先分析需求"],
        ["assistant", "好的"],
      ],
    );
  });
});

it("旧 schema（role CHECK 不含 reasoning）迁移后允许推理落库", async () => {
  await withTempDb((path) => {
    // 手工构造旧版 messages 表（无 tool_call_id/tool_name、CHECK 无 reasoning）
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT 'New chat',
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
        content TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        status TEXT,
        position INTEGER NOT NULL
      );
      INSERT INTO sessions (id, title, updated_at) VALUES ('s1', 'legacy', 0);
      INSERT INTO messages (id, session_id, role, content, created_at, position)
        VALUES ('m1', 's1', 'user', 'old msg', 0, 0);
    `);
    legacy.close();

    // openDb 触发迁移（补列 + 重建 CHECK）
    openDb();
    const session = createSession({ id: "s2" });
    addMessage(session.id, { role: "reasoning", content: "迁移后写入的推理" });

    const legacySession = getSession("s1");
    assert.ok(legacySession);
    // 旧数据完好
    assert.deepEqual(
      legacySession.messages.map((m) => [m.role, m.content]),
      [["user", "old msg"]],
    );
    // 新库可写 reasoning
    const migrated = getSession(session.id);
    assert.ok(migrated);
    assert.ok(migrated.messages.some((m) => m.role === "reasoning"));
  });
});
