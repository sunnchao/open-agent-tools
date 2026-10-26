/**
 * im 域的表定义与迁移。
 *
 * 由 `platform/db.ts` 的迁移执行器按 `SCHEMA_ORDER` 顺序调用；
 * 所有语句必须幂等（CREATE ... IF NOT EXISTS / PRAGMA 补列）。
 */
import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_WORKSPACE_ID } from "../db.js";

export const DDL = `

    CREATE TABLE IF NOT EXISTS im_channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      platform TEXT NOT NULL,
      app_id TEXT NOT NULL,
      app_secret_enc TEXT,
      encrypt_key_enc TEXT,
      rag_sources_json TEXT NOT NULL DEFAULT '[]',
      sql_sources_json TEXT NOT NULL DEFAULT '[]',
      mcp_tools_json TEXT NOT NULL DEFAULT '[]',
      rag_top_k INTEGER NOT NULL DEFAULT 5,
      require_mention INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      -- 渠道所属 workspace：IM 问答产生的会话与用量都归到该空间。
      workspace_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- IM 对话账号：按渠道保存全部曾参与对话的外部用户。
    -- 故意不对 im_channels 建外键：渠道删除后账号与审计历史仍需保留。
    CREATE TABLE IF NOT EXISTS im_channel_accounts (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'default',
      channel_id TEXT NOT NULL,
      channel_name TEXT NOT NULL DEFAULT '',
      platform TEXT NOT NULL,
      external_user_id TEXT NOT NULL,
      external_user_id_type TEXT,
      external_name TEXT,
      display_name TEXT,
      remark TEXT,
      provider_id TEXT,
      model TEXT,
      first_interacted_at INTEGER NOT NULL,
      last_interacted_at INTEGER NOT NULL,
      last_conversation_id TEXT,
      last_chat_type TEXT,
      channel_deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_im_channel_accounts_identity
      ON im_channel_accounts(channel_id, external_user_id);
    CREATE INDEX IF NOT EXISTS idx_im_channel_accounts_workspace
      ON im_channel_accounts(workspace_id, last_interacted_at DESC);
    CREATE INDEX IF NOT EXISTS idx_im_channel_accounts_channel
      ON im_channel_accounts(channel_id, last_interacted_at DESC);

    CREATE TABLE IF NOT EXISTS im_account_migrations (
      key TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    -- 入站事件幂等台账：平台重投时不再重复回答。
    CREATE TABLE IF NOT EXISTS im_inbound_events (
      channel_id TEXT NOT NULL,
      platform_message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'received',
      received_at INTEGER NOT NULL,
      PRIMARY KEY (channel_id, platform_message_id)
    );`;

/**
 * 为存量库补齐 im_channels.sql_sources_json / mcp_tools_json 列。
 * 新建库由 CREATE TABLE 直接带上；老库必须 ALTER，否则 store 的 SELECT * 会缺列。
 */
export function migrateImChannelsTable(database: DatabaseSync): void {
  const rows = database.prepare(`PRAGMA table_info(im_channels)`).all() as Array<{ name: string }>;
  if (rows.length === 0) return;
  const columns = new Set(rows.map((row) => row.name));
  const additions: Array<[string, string]> = [
    ["sql_sources_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["mcp_tools_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["workspace_id", `TEXT NOT NULL DEFAULT '${DEFAULT_WORKSPACE_ID}'`],
  ];
  for (const [name, definition] of additions) {
    if (!columns.has(name)) {
      database.exec(`ALTER TABLE im_channels ADD COLUMN ${name} ${definition}`);
    }
  }
}
