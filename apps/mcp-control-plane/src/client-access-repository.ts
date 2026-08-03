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
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryClientAccessRepository implements ClientAccessRepository {
  readonly clients = new Map<string, ApiClientRecord>();
  readonly keys = new Map<string, StoredApiKeyRecord>();
  readonly grants = new Map<string, ClientGrantRecord>();
  readonly serviceIds = new Set<string>();

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
}
