import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

export type PgSchema = Record<string, unknown>;

/**
 * Creates a Drizzle `NodePgDatabase` instance backed by the given `pg` Pool.
 *
 * Pass the schema map (e.g. `* as schema` from a Drizzle schema module) when
 * typed table helpers are required. The returned database is fully typed.
 */
export function createPostgresDatabase<TSchema extends PgSchema = Record<string, never>>(
  pool: Pool,
  schema?: TSchema,
): NodePgDatabase<TSchema> {
  return schema === undefined
    ? (drizzle(pool) as NodePgDatabase<TSchema>)
    : drizzle(pool, { schema });
}
