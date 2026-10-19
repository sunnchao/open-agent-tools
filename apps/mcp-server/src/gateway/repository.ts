import type {
  ExecutionLimits,
  ManagedTool,
  PromptDefinition,
  RemoteServiceConfig,
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
  /** REMOTE_MCP：上游第三方 MCP Server 接入配置；MANAGED_MCP 为 null。 */
  remote?: RemoteServiceConfig | null;
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

export interface GatewayQuotaRecord {
  clientId: string;
  serviceId: string | null;
  qpsLimit: number;
  dailyCallLimit: number;
}

export interface ToolCallReservation {
  clientId: string;
  serviceId: string;
  versionId: string;
  toolName: string;
  requestId: string;
}

export interface ToolCallReservationInput extends ToolCallReservation {
  now: string;
}

export type ToolCallReservationResult =
  { reserved: true } | { reserved: false; retryAfterSeconds: number };

export interface ToolCallSettlement {
  requestId: string;
  status: "SUCCEEDED" | "FAILED";
  durationMs: number;
  finishedAt: string;
}

export interface GatewayRepository {
  getApiKey(keyId: string): Promise<ApiKeyRecord | null>;
  getClient(clientId: string): Promise<ApiClientRecord | null>;
  getManagedService(serviceSlug: string): Promise<ManagedServiceSnapshot | null>;
  listGrantsByClient(clientId: string): Promise<ClientGrantRecord[]>;
  getServiceByServiceId(serviceId: string): Promise<ServiceSummary | null>;
  getGrant(clientId: string, serviceId: string): Promise<ClientGrantRecord | null>;
  markApiKeyUsed(keyId: string, usedAt: string): Promise<void>;
  reserveToolCall(input: ToolCallReservationInput): Promise<ToolCallReservationResult>;
  settleToolCall(input: ToolCallSettlement): Promise<void>;
}

export interface InMemoryGatewayRepositoryInput {
  clients?: ApiClientRecord[];
  keys?: ApiKeyRecord[];
  grants?: ClientGrantRecord[];
  services?: ManagedServiceSnapshot[];
  quotas?: GatewayQuotaRecord[];
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
  readonly quotas = new Map<string, GatewayQuotaRecord>();
  readonly usageEvents = new Map<
    string,
    ToolCallReservationInput & {
      status: "RESERVED" | "SUCCEEDED" | "FAILED";
      durationMs?: number;
      finishedAt?: string;
    }
  >();

  constructor(input: InMemoryGatewayRepositoryInput = {}) {
    for (const client of input.clients ?? []) this.clients.set(client.id, clone(client));
    for (const key of input.keys ?? []) this.keys.set(key.id, clone(key));
    for (const grant of input.grants ?? []) {
      this.grants.set(`${grant.clientId}:${grant.serviceId}`, clone(grant));
    }
    for (const service of input.services ?? []) {
      this.services.set(service.serviceSlug, clone(service));
    }
    for (const quota of input.quotas ?? []) {
      this.quotas.set(quotaKey(quota.clientId, quota.serviceId), clone(quota));
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
    return service && service.serviceStatus !== "DELETED" ? clone(service) : null;
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
      if (service.serviceId === serviceId && service.serviceStatus !== "DELETED") {
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

  async reserveToolCall(input: ToolCallReservationInput): Promise<ToolCallReservationResult> {
    const now = Date.parse(input.now);
    const secondStart = now - 1_000;
    const qpsLimit = this.quotas.get(quotaKey(input.clientId, null))?.qpsLimit ?? 0;
    if (qpsLimit > 0) {
      const recent = [...this.usageEvents.values()]
        .filter((event) => event.clientId === input.clientId && Date.parse(event.now) > secondStart)
        .sort((left, right) => Date.parse(left.now) - Date.parse(right.now));
      if (recent.length >= qpsLimit) {
        const oldest = recent[0];
        return {
          reserved: false,
          retryAfterSeconds: retryAfter(oldest ? Date.parse(oldest.now) + 1_000 : now, now),
        };
      }
    }

    const dailyLimit =
      this.quotas.get(quotaKey(input.clientId, input.serviceId))?.dailyCallLimit ?? 0;
    if (dailyLimit > 0) {
      const dayStart = utcDayStart(now);
      const nextDay = dayStart + 86_400_000;
      const used = [...this.usageEvents.values()].filter(
        (event) =>
          event.clientId === input.clientId &&
          event.serviceId === input.serviceId &&
          Date.parse(event.now) >= dayStart &&
          Date.parse(event.now) < nextDay,
      ).length;
      if (used >= dailyLimit) {
        return { reserved: false, retryAfterSeconds: retryAfter(nextDay, now) };
      }
    }

    this.usageEvents.set(input.requestId, { ...clone(input), status: "RESERVED" });
    return { reserved: true };
  }

  async settleToolCall(input: ToolCallSettlement): Promise<void> {
    const event = this.usageEvents.get(input.requestId);
    if (!event || event.status !== "RESERVED") return;
    this.usageEvents.set(input.requestId, {
      ...event,
      status: input.status,
      durationMs: input.durationMs,
      finishedAt: input.finishedAt,
    });
  }
}

function quotaKey(clientId: string, serviceId: string | null): string {
  return `${clientId}:${serviceId ?? "*"}`;
}

function utcDayStart(value: number): number {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function retryAfter(at: number, now: number): number {
  return Math.max(1, Math.ceil((at - now) / 1_000));
}
