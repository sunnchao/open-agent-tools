/**
 * connectors 域的表定义与迁移。
 *
 * 由 `platform/db.ts` 的迁移执行器按 `SCHEMA_ORDER` 顺序调用；
 * 所有语句必须幂等（CREATE ... IF NOT EXISTS / PRAGMA 补列）。
 */

export const DDL = `

    -- 文档同步连接器(SKU A6):管理员配置外部知识源并增量同步进知识库。
    -- 只做新增表,不改动现有 schema;删除连接器时级联清理运行记录与去重台账。
    CREATE TABLE IF NOT EXISTS connectors (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      base_url TEXT,
      credentials_enc TEXT,
      credential_keys_json TEXT NOT NULL DEFAULT '[]',
      filter_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_status TEXT,
      last_synced_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS connector_sync_runs (
      id TEXT PRIMARY KEY,
      connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      pulled INTEGER NOT NULL DEFAULT 0,
      ingested INTEGER NOT NULL DEFAULT 0,
      skipped INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      failures_json TEXT NOT NULL DEFAULT '[]',
      error TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_connector_sync_runs_connector
      ON connector_sync_runs(connector_id, started_at DESC);

    -- 幂等台账:同一 (connector_id, external_id) 记录内容哈希,哈希未变即跳过。
    CREATE TABLE IF NOT EXISTS connector_documents (
      connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
      external_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      rag_source TEXT NOT NULL,
      byte_size INTEGER NOT NULL DEFAULT 0,
      ingested_at TEXT NOT NULL,
      PRIMARY KEY (connector_id, external_id)
    );`;
