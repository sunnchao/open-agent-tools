/**
 * metrics 域的表定义与迁移。
 *
 * 由 `platform/db.ts` 的迁移执行器按 `SCHEMA_ORDER` 顺序调用；
 * 所有语句必须幂等（CREATE ... IF NOT EXISTS / PRAGMA 补列）。
 */

export const DDL = `

    CREATE TABLE IF NOT EXISTS metric_definitions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT,
      unit TEXT,
      caliber_json TEXT NOT NULL,
      source_id TEXT,
      tables_json TEXT NOT NULL DEFAULT '[]',
      synonyms_json TEXT NOT NULL DEFAULT '[]',
      tags_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active',
      version INTEGER NOT NULL DEFAULT 1,
      owner TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_metric_definitions_category
      ON metric_definitions(category);
    CREATE INDEX IF NOT EXISTS idx_metric_definitions_status
      ON metric_definitions(status);`;
