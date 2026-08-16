import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool, PoolConfig } from "pg";

import { createPostgresDatabase, type PgSchema } from "./database.js";
import { createPostgresPool } from "./pool.js";

export interface PostgresConnection<TSchema extends PgSchema = Record<string, never>> {
  pool: Pool;
  database: NodePgDatabase<TSchema>;
  close: () => Promise<void>;
}

/**
 * One-stop helper for the common "connect to PostgreSQL" pattern used across
 * the MCP platform apps: creates a `pg` Pool, wraps it in a Drizzle database
 * (when a schema is provided), and returns a `close` handle for shutdown.
 *
 * ```ts
 * const { database, close } = createPostgresConnection(connectionString, {
 *   schema,
 * });
 * ```
 */
export function createPostgresConnection<
  TSchema extends PgSchema = Record<string, never>,
>(
  connectionString: string,
  options: {
    schema?: TSchema;
    pool?: Omit<PoolConfig, "connectionString">;
  } = {},
): PostgresConnection<TSchema> {
  const { pool, close } = createPostgresPool(connectionString, options.pool);
  const database = createPostgresDatabase(pool, options.schema);
  return { pool, database, close };
}
