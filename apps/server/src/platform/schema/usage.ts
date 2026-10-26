/**
 * usage 域的表定义与迁移。
 *
 * 由 `platform/db.ts` 的迁移执行器按 `SCHEMA_ORDER` 顺序调用；
 * 所有语句必须幂等（CREATE ... IF NOT EXISTS / PRAGMA 补列）。
 */
import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_WORKSPACE_ID } from "../db.js";

export const DDL = `

    -- 用量计量（商业化计费与成本对账的依据）：只做新增，不改动现有表。
    -- kind='chat' 记录整轮对话的 token 与工具轮数；kind='tool' 记录单次工具调用。
    CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('chat', 'tool')),
      workspace_id TEXT,
      session_id TEXT,
      provider_id TEXT,
      model TEXT,
      tool_kind TEXT,
      tool_name TEXT,
      source TEXT NOT NULL DEFAULT 'web_chat',
      requests INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ok',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_usage_events_created_at
      ON usage_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_events_kind_created_at
      ON usage_events(kind, created_at);`;

export function migrateUsageColumns(database: DatabaseSync): void {
  const columns = new Set(
    (database.prepare("PRAGMA table_info(usage_events)").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  if (columns.has("source") && columns.has("requests")) return;
  database.exec("BEGIN");
  try {
    if (!columns.has("source")) {
      database.exec("ALTER TABLE usage_events ADD COLUMN source TEXT NOT NULL DEFAULT 'web_chat'");
    }
    if (!columns.has("requests")) {
      database.exec("ALTER TABLE usage_events ADD COLUMN requests INTEGER NOT NULL DEFAULT 0");
      database.exec("UPDATE usage_events SET requests = 1 WHERE kind = 'chat'");
    }
    database
      .prepare("UPDATE usage_events SET workspace_id = ? WHERE workspace_id IS NULL")
      .run(DEFAULT_WORKSPACE_ID);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
