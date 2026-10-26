/**
 * schema 域的表定义与迁移。
 *
 * 由 `platform/db.ts` 的迁移执行器按 `SCHEMA_ORDER` 顺序调用；
 * 所有语句必须幂等（CREATE ... IF NOT EXISTS / PRAGMA 补列）。
 */
import type { DatabaseSync } from "node:sqlite";

export const DDL = `

    CREATE TABLE IF NOT EXISTS schema_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      connector TEXT NOT NULL DEFAULT 'mysql',
      connection_url_enc TEXT NOT NULL,
      database_name TEXT,
      schema_name TEXT,
      table_filter_json TEXT NOT NULL DEFAULT '[]',
      semantic_profile TEXT NOT NULL DEFAULT 'generic',
      enabled INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      sync_status TEXT NOT NULL DEFAULT 'idle',
      last_synced_at TEXT,
      last_error TEXT,
      table_count INTEGER NOT NULL DEFAULT 0,
      relation_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_schema_sources_default
      ON schema_sources(is_default) WHERE is_default = 1;`;

export function migrateSchemaSourcesTable(database: DatabaseSync): void {
  const rows = database.prepare(`PRAGMA table_info(schema_sources)`).all() as Array<{
    name: string;
  }>;
  const columns = new Set(rows.map((row) => row.name));
  const additions = [
    ["schema_name", "TEXT"],
    ["sync_status", "TEXT NOT NULL DEFAULT 'idle'"],
    ["last_synced_at", "TEXT"],
    ["last_error", "TEXT"],
    ["table_count", "INTEGER NOT NULL DEFAULT 0"],
    ["relation_count", "INTEGER NOT NULL DEFAULT 0"],
  ] as const;
  for (const [name, definition] of additions) {
    if (!columns.has(name)) {
      database.exec(`ALTER TABLE schema_sources ADD COLUMN ${name} ${definition}`);
    }
  }
}
