import { and, desc, eq, ilike, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { createPostgresConnection } from "@open-agent-tools/database/postgres";

import type { AuditEventQuery, AuditEventRecord, AuditRepository } from "../audit-repository.js";
import * as schema from "./schema.js";
import { mcpAuditEvents } from "./schema.js";

type Database = NodePgDatabase<typeof schema>;

export class PostgresAuditRepository implements AuditRepository {
  readonly #db: Database;

  constructor(database: Database) {
    this.#db = database;
  }

  async create(event: AuditEventRecord): Promise<void> {
    await this.#db.insert(mcpAuditEvents).values(event);
  }

  async list(query: AuditEventQuery): Promise<AuditEventRecord[]> {
    const conditions: SQL[] = [];
    if (query.outcome) conditions.push(eq(mcpAuditEvents.outcome, query.outcome));
    if (query.action) conditions.push(ilike(mcpAuditEvents.action, `%${query.action}%`));
    const rows = await this.#db
      .select()
      .from(mcpAuditEvents)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(mcpAuditEvents.createdAt))
      .limit(query.limit);
    return rows;
  }
}

export function createPostgresAuditRepository(connectionString: string): {
  repository: PostgresAuditRepository;
  close: () => Promise<void>;
} {
  const { database, close } = createPostgresConnection(connectionString, { schema });
  return {
    repository: new PostgresAuditRepository(database),
    close,
  };
}
