/**
 * providers 域的表定义与迁移。
 *
 * 由 `platform/db.ts` 的迁移执行器按 `SCHEMA_ORDER` 顺序调用；
 * 所有语句必须幂等（CREATE ... IF NOT EXISTS / PRAGMA 补列）。
 */
import type { DatabaseSync } from "node:sqlite";

export const DDL = `

    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key_enc TEXT,
      models_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      format TEXT NOT NULL DEFAULT 'openai-chat',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`;

export function providerColumns(database: DatabaseSync): Set<string> {
  const rows = database.prepare(`PRAGMA table_info(providers)`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}
export function migrateProvidersTable(database: DatabaseSync): void {
  if (!providerColumns(database).has("format")) {
    database.exec(`ALTER TABLE providers ADD COLUMN format TEXT NOT NULL DEFAULT 'openai-chat'`);
  }
}
