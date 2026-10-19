import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { createPostgresConnection } from "@open-agent-tools/database/postgres";
import type {
  ApiClientRecord,
  ClientAccessRepository,
  ClientGrantRecord,
  McpScope,
  StoredApiKeyRecord,
} from "../client-access-repository.js";
import type {
  ClientQuotaRecord,
  UsageEventQuery,
  UsageEventRecord,
  UsageSummary,
} from "../types.js";
import * as schema from "./schema.js";
import {
  apiClients,
  apiKeys,
  clientGrants,
  clientQuotas,
  mcpServices,
  usageEvents,
} from "./schema.js";

type Database = NodePgDatabase<typeof schema>;

function mapClient(row: typeof apiClients.$inferSelect): ApiClientRecord {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapKey(row: typeof apiKeys.$inferSelect): StoredApiKeyRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    keyHash: row.keyHash,
    status: row.status,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  };
}

function mapGrant(row: typeof clientGrants.$inferSelect): ClientGrantRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    serviceId: row.serviceId,
    scopes: row.scopes as McpScope[],
    promptNames: row.promptNames,
    toolNames: row.toolNames,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapQuota(row: typeof clientQuotas.$inferSelect): ClientQuotaRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    serviceId: row.serviceId,
    qpsLimit: row.qpsLimit,
    dailyCallLimit: row.dailyCallLimit,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapUsageEvent(row: typeof usageEvents.$inferSelect): UsageEventRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    serviceId: row.serviceId,
    versionId: row.versionId,
    toolName: row.toolName,
    requestId: row.requestId,
    status: row.status,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
    durationMs: row.durationMs,
  };
}

function usageWhere(clientId: string, query: UsageEventQuery) {
  return and(
    eq(usageEvents.clientId, clientId),
    query.serviceId === undefined ? undefined : eq(usageEvents.serviceId, query.serviceId),
    query.from === undefined ? undefined : sql`${usageEvents.createdAt} >= ${query.from}`,
    query.to === undefined ? undefined : sql`${usageEvents.createdAt} <= ${query.to}`,
  );
}

export class PostgresClientAccessRepository implements ClientAccessRepository {
  readonly #db: Database;

  constructor(database: Database) {
    this.#db = database;
  }

  async createClient(client: ApiClientRecord): Promise<ApiClientRecord> {
    const [row] = await this.#db.insert(apiClients).values(client).returning();
    if (!row) throw new Error("Failed to create API client");
    return mapClient(row);
  }

  async getClient(clientId: string): Promise<ApiClientRecord | null> {
    const [row] = await this.#db
      .select()
      .from(apiClients)
      .where(eq(apiClients.id, clientId))
      .limit(1);
    return row ? mapClient(row) : null;
  }

  async listClients(): Promise<ApiClientRecord[]> {
    return (await this.#db.select().from(apiClients).orderBy(desc(apiClients.createdAt))).map(
      mapClient,
    );
  }

  async createApiKey(key: StoredApiKeyRecord): Promise<StoredApiKeyRecord> {
    const [row] = await this.#db.insert(apiKeys).values(key).returning();
    if (!row) throw new Error("Failed to create API Key");
    return mapKey(row);
  }

  async getApiKey(keyId: string): Promise<StoredApiKeyRecord | null> {
    const [row] = await this.#db.select().from(apiKeys).where(eq(apiKeys.id, keyId)).limit(1);
    return row ? mapKey(row) : null;
  }

  async listApiKeys(clientId: string): Promise<StoredApiKeyRecord[]> {
    return (
      await this.#db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.clientId, clientId))
        .orderBy(desc(apiKeys.createdAt))
    ).map(mapKey);
  }

  async revokeApiKey(clientId: string, keyId: string): Promise<StoredApiKeyRecord | null> {
    const [row] = await this.#db
      .update(apiKeys)
      .set({ status: "REVOKED" })
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.clientId, clientId)))
      .returning();
    return row ? mapKey(row) : null;
  }

  async getGrant(clientId: string, serviceId: string): Promise<ClientGrantRecord | null> {
    const [row] = await this.#db
      .select()
      .from(clientGrants)
      .where(and(eq(clientGrants.clientId, clientId), eq(clientGrants.serviceId, serviceId)))
      .limit(1);
    return row ? mapGrant(row) : null;
  }

  async listGrants(clientId: string): Promise<ClientGrantRecord[]> {
    return (
      await this.#db
        .select()
        .from(clientGrants)
        .where(eq(clientGrants.clientId, clientId))
        .orderBy(clientGrants.serviceId)
    ).map(mapGrant);
  }

  async upsertGrant(grant: ClientGrantRecord): Promise<ClientGrantRecord> {
    const [row] = await this.#db
      .insert(clientGrants)
      .values(grant)
      .onConflictDoUpdate({
        target: [clientGrants.clientId, clientGrants.serviceId],
        set: {
          scopes: grant.scopes,
          promptNames: grant.promptNames,
          toolNames: grant.toolNames,
          updatedAt: grant.updatedAt,
        },
      })
      .returning();
    if (!row) throw new Error("Failed to save client grant");
    return mapGrant(row);
  }

  async deleteGrant(clientId: string, serviceId: string): Promise<boolean> {
    const rows = await this.#db
      .delete(clientGrants)
      .where(and(eq(clientGrants.clientId, clientId), eq(clientGrants.serviceId, serviceId)))
      .returning({ id: clientGrants.id });
    return rows.length > 0;
  }

  async serviceExists(serviceId: string): Promise<boolean> {
    const [row] = await this.#db
      .select({ id: mcpServices.id })
      .from(mcpServices)
      .where(eq(mcpServices.id, serviceId))
      .limit(1);
    return Boolean(row);
  }

  async listClientQuotas(clientId: string): Promise<ClientQuotaRecord[]> {
    const rows = await this.#db
      .select()
      .from(clientQuotas)
      .where(eq(clientQuotas.clientId, clientId))
      .orderBy(asc(clientQuotas.serviceId));
    return rows.map(mapQuota);
  }

  async upsertClientQuota(quota: ClientQuotaRecord): Promise<ClientQuotaRecord> {
    const [existing] = await this.#db
      .select({ id: clientQuotas.id })
      .from(clientQuotas)
      .where(
        and(
          eq(clientQuotas.clientId, quota.clientId),
          quota.serviceId === null
            ? sql`${clientQuotas.serviceId} IS NULL`
            : eq(clientQuotas.serviceId, quota.serviceId),
        ),
      )
      .limit(1);
    const [row] = existing
      ? await this.#db
          .update(clientQuotas)
          .set({
            qpsLimit: quota.qpsLimit,
            dailyCallLimit: quota.dailyCallLimit,
            updatedAt: quota.updatedAt,
          })
          .where(eq(clientQuotas.id, existing.id))
          .returning()
      : await this.#db.insert(clientQuotas).values(quota).returning();
    if (!row) throw new Error(`Failed to save quota for client: ${quota.clientId}`);
    return mapQuota(row);
  }

  async listUsageEvents(clientId: string, query: UsageEventQuery): Promise<UsageEventRecord[]> {
    const rows = await this.#db
      .select()
      .from(usageEvents)
      .where(usageWhere(clientId, query))
      .orderBy(desc(usageEvents.createdAt))
      .limit(query.limit);
    return rows.map(mapUsageEvent);
  }

  async summarizeUsage(clientId: string, query: UsageEventQuery): Promise<UsageSummary> {
    const [row] = await this.#db
      .select({
        total: sql<number>`count(*)::int`,
        reserved: sql<number>`count(*) filter (where ${usageEvents.status} = 'RESERVED')::int`,
        succeeded: sql<number>`count(*) filter (where ${usageEvents.status} = 'SUCCEEDED')::int`,
        failed: sql<number>`count(*) filter (where ${usageEvents.status} = 'FAILED')::int`,
      })
      .from(usageEvents)
      .where(usageWhere(clientId, query));
    return row ?? { total: 0, reserved: 0, succeeded: 0, failed: 0 };
  }
}

export function createPostgresClientAccessRepository(connectionString: string): {
  repository: PostgresClientAccessRepository;
  close: () => Promise<void>;
} {
  const { database, close } = createPostgresConnection(connectionString, { schema });
  return {
    repository: new PostgresClientAccessRepository(database),
    close,
  };
}
