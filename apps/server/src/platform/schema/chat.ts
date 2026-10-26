/**
 * chat 域的表定义与迁移。
 *
 * 由 `platform/db.ts` 的迁移执行器按 `SCHEMA_ORDER` 顺序调用；
 * 所有语句必须幂等（CREATE ... IF NOT EXISTS / PRAGMA 补列）。
 */
import type { DatabaseSync } from "node:sqlite";
import { sqliteTableColumns } from "@open-agent-tools/database/sqlite";

export const DDL = `
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New chat',
      updated_at INTEGER NOT NULL,
      workspace_id TEXT NOT NULL DEFAULT 'default',
      -- 来源：'web'（Web/App 聊天）或 'im'（IM 机器人）。
      -- IM 会话统一标记为 'im'，平台信息放在 actor / channel_id 上，
      -- 这样筛选时只需按 source 切分，不必为每个平台各建一列。
      source TEXT NOT NULL DEFAULT 'web',
      -- IM 来源的平台用户 id（私聊与群聊都记录），Web 会话为 NULL。
      actor TEXT,
      -- IM 来源的渠道 id，Web 会话为 NULL。
      channel_id TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
      content TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      status TEXT,
      position INTEGER NOT NULL,
      tool_call_id TEXT,
      tool_name TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session_position
      ON messages(session_id, position);`;

export function migrateMessagesTable(database: DatabaseSync): void {
  const columns = sqliteTableColumns(database, "messages");

  if (!columns.has("tool_call_id")) {
    database.exec(`ALTER TABLE messages ADD COLUMN tool_call_id TEXT`);
  }
  if (!columns.has("tool_name")) {
    database.exec(`ALTER TABLE messages ADD COLUMN tool_name TEXT`);
  }

  // Drop leftover backup from a previous failed rebuild migration.
  database.exec(`DROP TABLE IF EXISTS messages_migration_backup`);
}

/**
 * 为存量库补齐 sessions 的来源列（source / actor / channel_id）。
 * 存量会话一律视为 Web 会话（source='web'），避免出现在 IM 审计里。
 */
export function migrateSessionSourceColumns(database: DatabaseSync): void {
  const rows = database.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
  if (rows.length === 0) return;
  const columns = new Set(rows.map((row) => row.name));
  const additions: Array<[string, string]> = [
    ["source", "TEXT NOT NULL DEFAULT 'web'"],
    ["actor", "TEXT"],
    ["channel_id", "TEXT"],
  ];
  for (const [name, definition] of additions) {
    if (!columns.has(name)) {
      database.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${definition}`);
    }
  }
  database.exec(
    `CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source, workspace_id, updated_at DESC)`,
  );
}
