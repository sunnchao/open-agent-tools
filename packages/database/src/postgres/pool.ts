import { Pool, type PoolConfig } from "pg";

export interface PostgresPool {
  pool: Pool;
  close: () => Promise<void>;
}

/**
 * Creates a `pg` connection Pool from a connection string.
 *
 * Any `PoolConfig` options (host, port, ssl, max, ...) can be passed in the
 * second argument; `connectionString` is always taken from the first argument.
 */
export function createPostgresPool(
  connectionString: string,
  options: Omit<PoolConfig, "connectionString"> = {},
): PostgresPool {
  const pool = new Pool({ connectionString, ...options });
  return {
    pool,
    close: () => pool.end(),
  };
}
