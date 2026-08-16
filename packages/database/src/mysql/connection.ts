import type { MySql2Database } from "drizzle-orm/mysql2";
import type { Pool, PoolOptions } from "mysql2/promise";

import { createMysqlDatabase, type MysqlSchema } from "./database.js";
import { createMysqlPool } from "./pool.js";

export interface MysqlConnection<TSchema extends MysqlSchema = Record<string, never>> {
  pool: Pool;
  database: MySql2Database<TSchema>;
  close: () => Promise<void>;
}

/**
 * 创建 MySQL 连接：mysql2 连接池 + Drizzle 数据库实例 + close 句柄。
 *
 * ```ts
 * const { database, close } = createMysqlConnection(connectionString, { schema });
 * ```
 */
export function createMysqlConnection<TSchema extends MysqlSchema = Record<string, never>>(
  connectionString: string,
  options: {
    schema?: TSchema;
    pool?: Omit<PoolOptions, "uri">;
  } = {},
): MysqlConnection<TSchema> {
  const { pool, close } = createMysqlPool(connectionString, options.pool);
  const database = createMysqlDatabase(pool, options.schema);
  return { pool, database, close };
}
