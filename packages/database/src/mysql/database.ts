import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import type { Pool } from "mysql2/promise";

export type MysqlSchema = Record<string, unknown>;

/**
 * 创建基于 mysql2 连接池的 Drizzle `MySql2Database` 实例。
 *
 * 传入 schema map（如 Drizzle schema 模块的 `* as schema`）以获得完整类型提示。
 */
export function createMysqlDatabase<TSchema extends MysqlSchema = Record<string, never>>(
  pool: Pool,
  schema?: TSchema,
): MySql2Database<TSchema> {
  return schema === undefined
    ? (drizzle(pool) as MySql2Database<TSchema>)
    : drizzle(pool, { schema, mode: "default" });
}
