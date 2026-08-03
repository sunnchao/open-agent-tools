import { randomBytes, randomUUID } from "node:crypto";
import { createApiKey } from "@open-agent-tools/mcp-auth";
import { CapabilityNameSchema } from "@open-agent-tools/mcp-contracts";
import { z } from "zod";
import type {
  ApiClientRecord,
  ApiKeyView,
  ClientAccessRepository,
  ClientGrantRecord,
  McpScope,
  StoredApiKeyRecord,
} from "./client-access-repository.js";
import { ManagementError, type Actor, type IdGenerator } from "./management.js";

const CreateClientSchema = z.object({ name: z.string().trim().min(1).max(120) }).strict();
const CreateApiKeySchema = z
  .object({ expiresAt: z.string().datetime().nullable().optional() })
  .strict();
const ScopeSchema = z.enum([
  "mcp:connect",
  "tools:list",
  "tools:call",
  "prompts:list",
  "prompts:get",
]);
const GrantInputSchema = z
  .object({
    scopes: z
      .array(ScopeSchema)
      .min(1)
      .refine(
        (scopes) => new Set(scopes).size === scopes.length,
        "Duplicate scopes are not allowed",
      )
      .refine((scopes) => scopes.includes("mcp:connect"), "mcp:connect is required"),
    promptNames: z.array(CapabilityNameSchema).nullable(),
    toolNames: z.array(CapabilityNameSchema).nullable(),
  })
  .strict();

export interface ClientAccessServiceOptions {
  createId?: IdGenerator;
  now?: () => string;
  secretSource?: () => Buffer;
}

function publicKey(key: StoredApiKeyRecord): ApiKeyView {
  const { keyHash: _keyHash, ...view } = key;
  return view;
}

function requireAdmin(actor: Actor): void {
  if (actor.role !== "admin") {
    throw new ManagementError("FORBIDDEN", "This operation requires admin access");
  }
}

function requireReader(actor: Actor): void {
  if (actor.role === "operator") {
    throw new ManagementError("FORBIDDEN", "Client credentials require admin or auditor access");
  }
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ManagementError("VALIDATION_ERROR", "Request validation failed", result.error.issues);
  }
  return result.data;
}

export class ClientAccessService {
  readonly #repository: ClientAccessRepository;
  readonly #createId: IdGenerator;
  readonly #now: () => string;
  readonly #secretSource: () => Buffer;

  constructor(repository: ClientAccessRepository, options: ClientAccessServiceOptions = {}) {
    this.#repository = repository;
    this.#createId = options.createId ?? randomUUID;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#secretSource = options.secretSource ?? (() => randomBytes(32));
  }

  async createClient(input: { name: string }, actor: Actor): Promise<ApiClientRecord> {
    requireAdmin(actor);
    const parsed = parse(CreateClientSchema, input);
    const now = this.#now();
    return this.#repository.createClient({
      id: this.#createId(),
      name: parsed.name,
      status: "ACTIVE",
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
  }

  async listClients(actor: Actor): Promise<ApiClientRecord[]> {
    requireReader(actor);
    return this.#repository.listClients();
  }

  async createApiKey(
    clientId: string,
    input: { expiresAt?: string | null },
    actor: Actor,
  ): Promise<{ key: ApiKeyView; rawKey: string }> {
    requireAdmin(actor);
    const client = await this.#client(clientId);
    if (client.status !== "ACTIVE") {
      throw new ManagementError("INVALID_STATE", "Cannot issue a key for a revoked client");
    }
    const parsed = parse(CreateApiKeySchema, input);
    const now = this.#now();
    const expiresAt = parsed.expiresAt ?? null;
    if (expiresAt !== null && expiresAt <= now) {
      throw new ManagementError("VALIDATION_ERROR", "API Key expiration must be in the future");
    }

    const id = this.#createId();
    const created = await createApiKey(id, this.#secretSource);
    const key = await this.#repository.createApiKey({
      id,
      clientId,
      keyHash: created.keyHash,
      status: "ACTIVE",
      expiresAt,
      lastUsedAt: null,
      createdAt: now,
    });
    return { key: publicKey(key), rawKey: created.rawKey };
  }

  async listApiKeys(clientId: string, actor: Actor): Promise<ApiKeyView[]> {
    requireReader(actor);
    await this.#client(clientId);
    return (await this.#repository.listApiKeys(clientId)).map(publicKey);
  }

  async revokeApiKey(clientId: string, keyId: string, actor: Actor): Promise<ApiKeyView> {
    requireAdmin(actor);
    await this.#client(clientId);
    const key = await this.#repository.revokeApiKey(clientId, keyId);
    if (!key) throw new ManagementError("NOT_FOUND", `API Key not found: ${keyId}`);
    return publicKey(key);
  }

  async upsertGrant(
    clientId: string,
    serviceId: string,
    input: { scopes: McpScope[]; promptNames: string[] | null; toolNames: string[] | null },
    actor: Actor,
  ): Promise<ClientGrantRecord> {
    requireAdmin(actor);
    await this.#client(clientId);
    if (!(await this.#repository.serviceExists(serviceId))) {
      throw new ManagementError("NOT_FOUND", `Service not found: ${serviceId}`);
    }
    const parsed = parse(GrantInputSchema, input);
    const existing = await this.#repository.getGrant(clientId, serviceId);
    const now = this.#now();
    return this.#repository.upsertGrant({
      id: existing?.id ?? this.#createId(),
      clientId,
      serviceId,
      scopes: parsed.scopes,
      promptNames: parsed.promptNames,
      toolNames: parsed.toolNames,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  async listGrants(clientId: string, actor: Actor): Promise<ClientGrantRecord[]> {
    requireReader(actor);
    await this.#client(clientId);
    return this.#repository.listGrants(clientId);
  }

  async deleteGrant(clientId: string, serviceId: string, actor: Actor): Promise<void> {
    requireAdmin(actor);
    await this.#client(clientId);
    if (!(await this.#repository.deleteGrant(clientId, serviceId))) {
      throw new ManagementError("NOT_FOUND", "Client grant not found");
    }
  }

  async #client(clientId: string): Promise<ApiClientRecord> {
    const client = await this.#repository.getClient(clientId);
    if (!client) throw new ManagementError("NOT_FOUND", `API client not found: ${clientId}`);
    return client;
  }
}
