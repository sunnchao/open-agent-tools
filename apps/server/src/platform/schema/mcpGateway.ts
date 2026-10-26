/**
 * mcpGateway 域的表定义与迁移。
 *
 * 由 `platform/db.ts` 的迁移执行器按 `SCHEMA_ORDER` 顺序调用；
 * 所有语句必须幂等（CREATE ... IF NOT EXISTS / PRAGMA 补列）。
 */

export const DDL = `

    CREATE TABLE IF NOT EXISTS mcp_gateway_config (
      id TEXT PRIMARY KEY,
      gateway_url TEXT NOT NULL,
      api_key_enc TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`;
