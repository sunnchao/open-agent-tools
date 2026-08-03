import type {
  ExecutionLimits,
  ManagedTool,
  PromptDefinition,
} from "@open-agent-tools/mcp-contracts";

export type McpScope = "mcp:connect" | "tools:list" | "tools:call" | "prompts:list" | "prompts:get";

export interface ApiClientRecord {
  id: string;
  status: "ACTIVE" | "REVOKED";
}

export interface ApiKeyRecord {
  id: string;
  clientId: string;
  keyHash: string;
  status: "ACTIVE" | "REVOKED";
  expiresAt: string | null;
}

export interface ClientGrantRecord {
  clientId: string;
  serviceId: string;
  scopes: McpScope[];
  promptNames: string[] | null;
  toolNames: string[] | null;
}

export interface ManagedServiceSnapshot {
  serviceId: string;
  serviceSlug: string;
  serviceStatus: "DRAFT" | "ACTIVE" | "DISABLED" | "DELETED";
  versionId: string;
  versionStatus:
    "DRAFT" | "VALIDATING" | "BUILDING" | "READY" | "FAILED" | "PUBLISHED" | "SUPERSEDED";
  imageDigest: string | null;
  limits: ExecutionLimits | null;
  tools: ManagedTool[];
  prompts: PromptDefinition[];
}

export interface PromptMetadata {
  name: string;
  title?: string;
  description?: string;
  arguments: Array<{ name: string; required: boolean }>;
}

function toPromptMetadata(prompt: PromptDefinition): PromptMetadata {
  return {
    name: prompt.name,
    ...(prompt.title === undefined ? {} : { title: prompt.title }),
    ...(prompt.description === undefined ? {} : { description: prompt.description }),
    arguments: prompt.arguments.map((argument) => ({
      name: argument.name,
      required: argument.required,
    })),
  };
}

export interface ServiceSummary {
  serviceSlug: string;
  serviceStatus: ManagedServiceSnapshot["serviceStatus"];
  versionStatus: ManagedServiceSnapshot["versionStatus"];
  prompts: PromptMetadata[];
}

export interface GatewayRepository {
  getApiKey(keyId: string): Promise<ApiKeyRecord | null>;
  getClient(clientId: string): Promise<ApiClientRecord | null>;
  getManagedService(serviceSlug: string): Promise<ManagedServiceSnapshot | null>;
  listGrantsByClient(clientId: string): Promise<ClientGrantRecord[]>;
  getServiceByServiceId(serviceId: string): Promise<ServiceSummary | null>;
  getGrant(clientId: string, serviceId: string): Promise<ClientGrantRecord | null>;
  markApiKeyUsed(keyId: string, usedAt: string): Promise<void>;
}

export interface InMemoryGatewayRepositoryInput {
  clients?: ApiClientRecord[];
  keys?: ApiKeyRecord[];
  grants?: ClientGrantRecord[];
  services?: ManagedServiceSnapshot[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryGatewayRepository implements GatewayRepository {
  readonly clients = new Map<string, ApiClientRecord>();
  readonly keys = new Map<string, ApiKeyRecord>();
  readonly grants = new Map<string, ClientGrantRecord>();
  readonly services = new Map<string, ManagedServiceSnapshot>();
  readonly lastUsedAt = new Map<string, string>();

  constructor(input: InMemoryGatewayRepositoryInput = {}) {
    for (const client of input.clients ?? []) this.clients.set(client.id, clone(client));
    for (const key of input.keys ?? []) this.keys.set(key.id, clone(key));
    for (const grant of input.grants ?? []) {
      this.grants.set(`${grant.clientId}:${grant.serviceId}`, clone(grant));
    }
    for (const service of input.services ?? []) {
      this.services.set(service.serviceSlug, clone(service));
    }
  }

  async getApiKey(keyId: string): Promise<ApiKeyRecord | null> {
    const key = this.keys.get(keyId);
    return key ? clone(key) : null;
  }

  async getClient(clientId: string): Promise<ApiClientRecord | null> {
    const client = this.clients.get(clientId);
    return client ? clone(client) : null;
  }

  async getManagedService(serviceSlug: string): Promise<ManagedServiceSnapshot | null> {
    const service = this.services.get(serviceSlug);
    return service ? clone(service) : null;
  }

  async getGrant(clientId: string, serviceId: string): Promise<ClientGrantRecord | null> {
    const grant = this.grants.get(`${clientId}:${serviceId}`);
    return grant ? clone(grant) : null;
  }

  async listGrantsByClient(clientId: string): Promise<ClientGrantRecord[]> {
    return [...this.grants.values()].filter((grant) => grant.clientId === clientId).map(clone);
  }

  async getServiceByServiceId(serviceId: string): Promise<ServiceSummary | null> {
    for (const service of this.services.values()) {
      if (service.serviceId === serviceId) {
        return {
          serviceSlug: service.serviceSlug,
          serviceStatus: service.serviceStatus,
          versionStatus: service.versionStatus,
          prompts: service.prompts.map(toPromptMetadata),
        };
      }
    }
    return null;
  }

  async markApiKeyUsed(keyId: string, usedAt: string): Promise<void> {
    this.lastUsedAt.set(keyId, usedAt);
  }
}
