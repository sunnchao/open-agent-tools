import { createPool, type Pool, type PoolOptions } from "mysql2/promise";

export interface MysqlPool {
  pool: Pool;
  close: () => Promise<void>;
}

/**
 * 从连接串创建 MySQL 连接池。
 *
 * 第二个参数可传入任意 `PoolOptions`（host、port、ssl、connectionLimit ...），
 * `uri` 始终取自第一个参数。
 */
export function createMysqlPool(
  connectionString: string,
  options: Omit<PoolOptions, "uri"> = {},
): MysqlPool {
  const pool = createPool({ uri: connectionString, ...options });
  return {
    pool,
    close: () => pool.end(),
  };
}
