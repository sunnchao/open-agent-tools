import { parseApiKey, verifyApiKey } from "./api-key.js";
import type {
  ClientGrantRecord,
  GatewayRepository,
  ManagedServiceSnapshot,
  McpScope,
  PromptMetadata,
} from "./repository.js";

export type GatewayAccessErrorCode =
  "FORBIDDEN" | "NOT_FOUND" | "SERVICE_UNAVAILABLE" | "UNAUTHORIZED";

export class GatewayAccessError extends Error {
  readonly code: GatewayAccessErrorCode;

  constructor(code: GatewayAccessErrorCode, message: string) {
    super(message);
    this.name = "GatewayAccessError";
    this.code = code;
  }
}

export interface AuthorizedService {
  clientId: string;
  scopes: Set<McpScope>;
  promptNames: Set<string> | null;
  toolNames: Set<string> | null;
  snapshot: ManagedServiceSnapshot;
}

export interface AuthorizedServiceSummary {
  serviceSlug: string;
  serviceStatus: ManagedServiceSnapshot["serviceStatus"];
  versionStatus: ManagedServiceSnapshot["versionStatus"];
  scopes: McpScope[];
  toolNames: string[] | null;
  promptNames: string[] | null;
  prompts: PromptMetadata[];
}

export interface GatewayAccessServiceOptions {
  now?: () => string;
}

export class GatewayAccessService {
  readonly #repository: GatewayRepository;
  readonly #now: () => string;

  constructor(repository: GatewayRepository, options: GatewayAccessServiceOptions = {}) {
    this.#repository = repository;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async authorize(rawKey: string, serviceSlug: string): Promise<AuthorizedService> {
    const { keyId, clientId, now } = await this.authenticateKey(rawKey);

    const snapshot = await this.#repository.getManagedService(serviceSlug);
    if (!snapshot) throw new GatewayAccessError("NOT_FOUND", "MCP service not found");
    if (snapshot.serviceStatus !== "ACTIVE" || snapshot.versionStatus !== "PUBLISHED") {
      throw new GatewayAccessError("SERVICE_UNAVAILABLE", "MCP service is unavailable");
    }

    const grant = await this.#repository.getGrant(clientId, snapshot.serviceId);
    if (!grant || !grant.scopes.includes("mcp:connect")) {
      throw new GatewayAccessError("FORBIDDEN", "Client is not granted access to this service");
    }

    await this.#repository.markApiKeyUsed(keyId, now);
    return {
      clientId,
      scopes: new Set(grant.scopes),
      promptNames: grant.promptNames === null ? null : new Set(grant.promptNames),
      toolNames: grant.toolNames === null ? null : new Set(grant.toolNames),
      snapshot,
    };
  }

  /** 校验 Key 与 Client 状态,返回身份信息;失败统一抛 UNAUTHORIZED。 */
  private async authenticateKey(
    rawKey: string,
  ): Promise<{ keyId: string; clientId: string; now: string }> {
    const parsed = parseApiKey(rawKey);
    if (!parsed) throw unauthorized();
    const key = await this.#repository.getApiKey(parsed.keyId);
    if (!key || key.status !== "ACTIVE" || !(await verifyApiKey(rawKey, key.keyHash))) {
      throw unauthorized();
    }

    const now = this.#now();
    if (key.expiresAt !== null && key.expiresAt <= now) throw unauthorized();
    const client = await this.#repository.getClient(key.clientId);
    if (!client || client.status !== "ACTIVE") throw unauthorized();
    return { keyId: key.id, clientId: client.id, now };
  }

  /** 返回该 Key 全部已授权(含 mcp:connect)服务的摘要,按 serviceSlug 升序。 */
  async listAuthorizedServices(rawKey: string): Promise<AuthorizedServiceSummary[]> {
    const { keyId, clientId, now } = await this.authenticateKey(rawKey);
    const grants = await this.#repository.listGrantsByClient(clientId);

    const summaries: AuthorizedServiceSummary[] = [];
    for (const grant of grants) {
      if (!grant.scopes.includes("mcp:connect")) continue;
      const service = await this.#repository.getServiceByServiceId(grant.serviceId);
      if (!service) continue;
      summaries.push({
        serviceSlug: service.serviceSlug,
        serviceStatus: service.serviceStatus,
        versionStatus: service.versionStatus,
        scopes: grant.scopes,
        toolNames: grant.toolNames,
        promptNames: grant.promptNames,
        prompts: visiblePrompts(service.prompts, grant),
      });
    }
    summaries.sort((left, right) => left.serviceSlug.localeCompare(right.serviceSlug));
    await this.#repository.markApiKeyUsed(keyId, now);
    return summaries;
  }
}

function visiblePrompts(prompts: PromptMetadata[], grant: ClientGrantRecord): PromptMetadata[] {
  if (!grant.scopes.includes("prompts:list")) return [];
  const allowed = grant.promptNames === null ? null : new Set(grant.promptNames);
  return prompts
    .filter((prompt) => allowed === null || allowed.has(prompt.name))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function unauthorized(): GatewayAccessError {
  return new GatewayAccessError("UNAUTHORIZED", "Missing or invalid API Key");
}
