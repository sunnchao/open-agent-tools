import { and, desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { createPostgresConnection } from "@open-agent-tools/database/postgres";
import type {
  ApiClientRecord,
  ClientAccessRepository,
  ClientGrantRecord,
  McpScope,
  StoredApiKeyRecord,
} from "../client-access-repository.js";
import * as schema from "./schema.js";
import { apiClients, apiKeys, clientGrants, mcpServices } from "./schema.js";

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
