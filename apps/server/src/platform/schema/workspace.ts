/**
 * workspace 域的表定义与迁移。
 *
 * 由 `platform/db.ts` 的迁移执行器按 `SCHEMA_ORDER` 顺序调用；
 * 所有语句必须幂等（CREATE ... IF NOT EXISTS / PRAGMA 补列）。
 */
import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_WORKSPACE_ID } from "../db.js";

export const DDL = `

    -- workspace：只做「一层隔离」，不引入完整多租户。
    -- 老数据一律归属 default，避免迁移期间出现无归属资源。
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`;

export function migrateWorkspaceColumns(database: DatabaseSync): void {
  const additions: Array<[string, string, string]> = [
    ["sessions", "workspace_id", `TEXT NOT NULL DEFAULT '${DEFAULT_WORKSPACE_ID}'`],
    ["usage_events", "workspace_id", "TEXT"],
  ];
  for (const [table, column, definition] of additions) {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    if (columns.length === 0) continue;
    if (!new Set(columns.map((row) => row.name)).has(column)) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
  database.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id)`);
  database.exec(
    `CREATE INDEX IF NOT EXISTS idx_usage_events_workspace ON usage_events(workspace_id, created_at)`,
  );
}

export function ensureDefaultWorkspace(database: DatabaseSync): void {
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO workspaces (id, name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(DEFAULT_WORKSPACE_ID, "默认空间", "存量数据与未指定归属的资源", now, now);
}
