import type {
  ClientQuotaRecord,
  UsageEventQuery,
  UsageEventRecord,
  UsageSummary,
} from "./types.js";

export type McpScope = "mcp:connect" | "tools:list" | "tools:call" | "prompts:list" | "prompts:get";

export interface ApiClientRecord {
  id: string;
  name: string;
  status: "ACTIVE" | "REVOKED";
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoredApiKeyRecord {
  id: string;
  clientId: string;
  keyHash: string;
  status: "ACTIVE" | "REVOKED";
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export type ApiKeyView = Omit<StoredApiKeyRecord, "keyHash">;

export interface ClientGrantRecord {
  id: string;
  clientId: string;
  serviceId: string;
  scopes: McpScope[];
  promptNames: string[] | null;
  toolNames: string[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClientAccessRepository {
  createClient(client: ApiClientRecord): Promise<ApiClientRecord>;
  getClient(clientId: string): Promise<ApiClientRecord | null>;
  listClients(): Promise<ApiClientRecord[]>;
  createApiKey(key: StoredApiKeyRecord): Promise<StoredApiKeyRecord>;
  getApiKey(keyId: string): Promise<StoredApiKeyRecord | null>;
  listApiKeys(clientId: string): Promise<StoredApiKeyRecord[]>;
  revokeApiKey(clientId: string, keyId: string): Promise<StoredApiKeyRecord | null>;
  getGrant(clientId: string, serviceId: string): Promise<ClientGrantRecord | null>;
  listGrants(clientId: string): Promise<ClientGrantRecord[]>;
  upsertGrant(grant: ClientGrantRecord): Promise<ClientGrantRecord>;
  deleteGrant(clientId: string, serviceId: string): Promise<boolean>;
  serviceExists(serviceId: string): Promise<boolean>;
  listClientQuotas(clientId: string): Promise<ClientQuotaRecord[]>;
  upsertClientQuota(quota: ClientQuotaRecord): Promise<ClientQuotaRecord>;
  listUsageEvents(clientId: string, query: UsageEventQuery): Promise<UsageEventRecord[]>;
  summarizeUsage(clientId: string, query: UsageEventQuery): Promise<UsageSummary>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryClientAccessRepository implements ClientAccessRepository {
  readonly clients = new Map<string, ApiClientRecord>();
  readonly keys = new Map<string, StoredApiKeyRecord>();
  readonly grants = new Map<string, ClientGrantRecord>();
  readonly serviceIds = new Set<string>();
  readonly clientQuotas = new Map<string, ClientQuotaRecord>();
  readonly usageEvents = new Map<string, UsageEventRecord>();

  constructor(input: { serviceIds?: string[] } = {}) {
    for (const serviceId of input.serviceIds ?? []) this.serviceIds.add(serviceId);
  }

  async createClient(client: ApiClientRecord): Promise<ApiClientRecord> {
    this.clients.set(client.id, clone(client));
    return clone(client);
  }

  async getClient(clientId: string): Promise<ApiClientRecord | null> {
    const client = this.clients.get(clientId);
    return client ? clone(client) : null;
  }

  async listClients(): Promise<ApiClientRecord[]> {
    return [...this.clients.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(clone);
  }

  async createApiKey(key: StoredApiKeyRecord): Promise<StoredApiKeyRecord> {
    this.keys.set(key.id, clone(key));
    return clone(key);
  }

  async getApiKey(keyId: string): Promise<StoredApiKeyRecord | null> {
    const key = this.keys.get(keyId);
    return key ? clone(key) : null;
  }

  async listApiKeys(clientId: string): Promise<StoredApiKeyRecord[]> {
    return [...this.keys.values()]
      .filter((key) => key.clientId === clientId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(clone);
  }

  async revokeApiKey(clientId: string, keyId: string): Promise<StoredApiKeyRecord | null> {
    const key = this.keys.get(keyId);
    if (!key || key.clientId !== clientId) return null;
    const revoked: StoredApiKeyRecord = { ...key, status: "REVOKED" };
    this.keys.set(keyId, clone(revoked));
    return clone(revoked);
  }

  async getGrant(clientId: string, serviceId: string): Promise<ClientGrantRecord | null> {
    const grant = this.grants.get(`${clientId}:${serviceId}`);
    return grant ? clone(grant) : null;
  }

  async listGrants(clientId: string): Promise<ClientGrantRecord[]> {
    return [...this.grants.values()]
      .filter((grant) => grant.clientId === clientId)
      .sort((left, right) => left.serviceId.localeCompare(right.serviceId))
      .map(clone);
  }

  async upsertGrant(grant: ClientGrantRecord): Promise<ClientGrantRecord> {
    this.grants.set(`${grant.clientId}:${grant.serviceId}`, clone(grant));
    return clone(grant);
  }

  async deleteGrant(clientId: string, serviceId: string): Promise<boolean> {
    return this.grants.delete(`${clientId}:${serviceId}`);
  }

  async serviceExists(serviceId: string): Promise<boolean> {
    return this.serviceIds.has(serviceId);
  }

  async listClientQuotas(clientId: string): Promise<ClientQuotaRecord[]> {
    return [...this.clientQuotas.values()]
      .filter((quota) => quota.clientId === clientId)
      .sort((left, right) => {
        if (left.serviceId === right.serviceId) return 0;
        if (left.serviceId === null) return -1;
        if (right.serviceId === null) return 1;
        return left.serviceId.localeCompare(right.serviceId);
      })
      .map(clone);
  }

  async upsertClientQuota(quota: ClientQuotaRecord): Promise<ClientQuotaRecord> {
    this.clientQuotas.set(quota.id, clone(quota));
    return clone(quota);
  }

  async listUsageEvents(clientId: string, query: UsageEventQuery): Promise<UsageEventRecord[]> {
    const from = query.from === undefined ? null : Date.parse(query.from);
    const to = query.to === undefined ? null : Date.parse(query.to);
    return [...this.usageEvents.values()]
      .filter((event) => {
        if (event.clientId !== clientId) return false;
        if (query.serviceId !== undefined && event.serviceId !== query.serviceId) return false;
        const createdAt = Date.parse(event.createdAt);
        return (from === null || createdAt >= from) && (to === null || createdAt <= to);
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, query.limit)
      .map(clone);
  }

  async summarizeUsage(clientId: string, query: UsageEventQuery): Promise<UsageSummary> {
    const from = query.from === undefined ? null : Date.parse(query.from);
    const to = query.to === undefined ? null : Date.parse(query.to);
    const events = [...this.usageEvents.values()].filter((event) => {
      if (event.clientId !== clientId) return false;
      if (query.serviceId !== undefined && event.serviceId !== query.serviceId) return false;
      const createdAt = Date.parse(event.createdAt);
      return (from === null || createdAt >= from) && (to === null || createdAt <= to);
    });
    return {
      total: events.length,
      reserved: events.filter((event) => event.status === "RESERVED").length,
      succeeded: events.filter((event) => event.status === "SUCCEEDED").length,
      failed: events.filter((event) => event.status === "FAILED").length,
    };
  }
}
