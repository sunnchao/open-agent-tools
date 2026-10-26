/**
 * apps 域的表定义与迁移。
 *
 * 由 `platform/db.ts` 的迁移执行器按 `SCHEMA_ORDER` 顺序调用；
 * 所有语句必须幂等（CREATE ... IF NOT EXISTS / PRAGMA 补列）。
 */
import type { DatabaseSync } from "node:sqlite";

export const DDL = `

    -- 发布态：把一个「知识库 + 资源绑定 + 提示词」打包成员工可用的入口。
    -- 与 Studio 管理台分离：终端用户只看到问答，不需要理解 Provider/资源抽屉。
    CREATE TABLE IF NOT EXISTS published_apps (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'default',
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      welcome TEXT NOT NULL DEFAULT '',
      suggestions_json TEXT NOT NULL DEFAULT '[]',
      resources_json TEXT NOT NULL DEFAULT '{}',
      allowed_groups_json TEXT NOT NULL DEFAULT '[]',
      provider_id TEXT,
      model TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      -- 访问控制：public 任何人可访问；token 需要携带访问口令（分享链接即凭证）。
      access_mode TEXT NOT NULL DEFAULT 'public',
      access_token_hash TEXT,
      access_token_hint TEXT,
      -- 配额：每分钟请求数上限 + 每日 token 预算（0 表示不限）。
      rate_limit_per_minute INTEGER NOT NULL DEFAULT 20,
      daily_token_budget INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_published_apps_workspace
      ON published_apps(workspace_id, created_at DESC);`;

export function migratePublishedAppColumns(database: DatabaseSync): void {
  const rows = database.prepare(`PRAGMA table_info(published_apps)`).all() as Array<{
    name: string;
  }>;
  if (rows.length === 0) return;
  const columns = new Set(rows.map((row) => row.name));
  const additions = [
    ["access_mode", "TEXT NOT NULL DEFAULT 'public'"],
    ["access_token_hash", "TEXT"],
    ["access_token_hint", "TEXT"],
    ["rate_limit_per_minute", "INTEGER NOT NULL DEFAULT 20"],
    ["daily_token_budget", "INTEGER NOT NULL DEFAULT 0"],
    ["allowed_groups_json", "TEXT NOT NULL DEFAULT '[]'"],
  ] as const;
  for (const [name, definition] of additions) {
    if (!columns.has(name)) {
      database.exec(`ALTER TABLE published_apps ADD COLUMN ${name} ${definition}`);
    }
  }
}
