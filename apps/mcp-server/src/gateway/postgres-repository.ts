import {
  ExecutionLimitsSchema,
  ManagedToolSchema,
  PromptDefinitionSchema,
} from "@open-agent-tools/mcp-contracts";
import type { Pool } from "pg";
import { z } from "zod";
import type {
  ApiClientRecord,
  ApiKeyRecord,
  ClientGrantRecord,
  GatewayRepository,
  ManagedServiceSnapshot,
  McpScope,
  ServiceSummary,
} from "./repository.js";
import { createPostgresPool } from "@open-agent-tools/database/postgres";

const ClientStatusSchema = z.enum(["ACTIVE", "REVOKED"]);
const KeyStatusSchema = z.enum(["ACTIVE", "REVOKED"]);
const ServiceStatusSchema = z.enum(["DRAFT", "ACTIVE", "DISABLED", "DELETED"]);
const VersionStatusSchema = z.enum([
  "DRAFT",
  "VALIDATING",
  "BUILDING",
  "READY",
  "FAILED",
  "PUBLISHED",
  "SUPERSEDED",
]);
const McpScopeSchema = z.enum([
  "mcp:connect",
  "tools:list",
  "tools:call",
  "prompts:list",
  "prompts:get",
]);

function timestamp(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export class PostgresGatewayRepository implements GatewayRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async getApiKey(keyId: string): Promise<ApiKeyRecord | null> {
    const result = await this.#pool.query<{
      id: string;
      client_id: string;
      key_hash: string;
      status: string;
      expires_at: Date | string | null;
    }>(
      `SELECT id, client_id, key_hash, status, expires_at
       FROM api_keys
       WHERE id = $1`,
      [keyId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      clientId: row.client_id,
      keyHash: row.key_hash,
      status: KeyStatusSchema.parse(row.status),
      expiresAt: timestamp(row.expires_at),
    };
  }

  async getClient(clientId: string): Promise<ApiClientRecord | null> {
    const result = await this.#pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM api_clients WHERE id = $1`,
      [clientId],
    );
    const row = result.rows[0];
    return row ? { id: row.id, status: ClientStatusSchema.parse(row.status) } : null;
  }

  async getManagedService(serviceSlug: string): Promise<ManagedServiceSnapshot | null> {
    const serviceResult = await this.#pool.query<{
      service_id: string;
      service_slug: string;
      service_status: string;
      version_id: string;
      version_status: string;
      image_digest: string | null;
      limits: unknown;
    }>(
      `SELECT service.id AS service_id,
              service.slug AS service_slug,
              service.status AS service_status,
              version.id AS version_id,
              version.status AS version_status,
              version.image_digest,
              version.limits
       FROM mcp_services AS service
       JOIN mcp_service_versions AS version ON version.id = service.current_version_id
       WHERE service.slug = $1`,
      [serviceSlug],
    );
    const service = serviceResult.rows[0];
    if (!service) return null;

    const [toolResult, promptResult] = await Promise.all([
      this.#pool.query<{
        name: string;
        description: string | null;
        handler: string;
        input_schema: Record<string, unknown>;
      }>(
        `SELECT name, description, handler, input_schema
         FROM mcp_tools
         WHERE version_id = $1
         ORDER BY position`,
        [service.version_id],
      ),
      this.#pool.query<{
        name: string;
        title: string | null;
        description: string | null;
        arguments: unknown;
        messages: unknown;
      }>(
        `SELECT name, title, description, arguments, messages
         FROM mcp_prompts
         WHERE version_id = $1
         ORDER BY position`,
        [service.version_id],
      ),
    ]);

    return {
      serviceId: service.service_id,
      serviceSlug: service.service_slug,
      serviceStatus: ServiceStatusSchema.parse(service.service_status),
      versionId: service.version_id,
      versionStatus: VersionStatusSchema.parse(service.version_status),
      imageDigest: service.image_digest,
      limits: service.limits === null ? null : ExecutionLimitsSchema.parse(service.limits),
      tools: toolResult.rows.map((row) =>
        ManagedToolSchema.parse({
          name: row.name,
          ...(row.description === null ? {} : { description: row.description }),
          handler: row.handler,
          inputSchema: row.input_schema,
        }),
      ),
      prompts: promptResult.rows.map((row) =>
        PromptDefinitionSchema.parse({
          name: row.name,
          ...(row.title === null ? {} : { title: row.title }),
          ...(row.description === null ? {} : { description: row.description }),
          arguments: row.arguments,
          messages: row.messages,
        }),
      ),
    };
  }

  async getGrant(clientId: string, serviceId: string): Promise<ClientGrantRecord | null> {
    const result = await this.#pool.query<{
      client_id: string;
      service_id: string;
      scopes: string[];
      prompt_names: string[] | null;
      tool_names: string[] | null;
    }>(
      `SELECT client_id, service_id, scopes, prompt_names, tool_names
       FROM client_grants
       WHERE client_id = $1 AND service_id = $2`,
      [clientId, serviceId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      clientId: row.client_id,
      serviceId: row.service_id,
      scopes: z.array(McpScopeSchema).parse(row.scopes) as McpScope[],
      promptNames: row.prompt_names,
      toolNames: row.tool_names,
    };
  }

  async markApiKeyUsed(keyId: string, usedAt: string): Promise<void> {
    await this.#pool.query(`UPDATE api_keys SET last_used_at = $2 WHERE id = $1`, [keyId, usedAt]);
  }

  async listGrantsByClient(clientId: string): Promise<ClientGrantRecord[]> {
    const result = await this.#pool.query<{
      client_id: string;
      service_id: string;
      scopes: string[];
      prompt_names: string[] | null;
      tool_names: string[] | null;
    }>(
      `SELECT client_id, service_id, scopes, prompt_names, tool_names
       FROM client_grants
       WHERE client_id = $1
       ORDER BY service_id`,
      [clientId],
    );
    return result.rows.map((row) => ({
      clientId: row.client_id,
      serviceId: row.service_id,
      scopes: z.array(McpScopeSchema).parse(row.scopes) as McpScope[],
      promptNames: row.prompt_names,
      toolNames: row.tool_names,
    }));
  }

  async getServiceByServiceId(serviceId: string): Promise<ServiceSummary | null> {
    const result = await this.#pool.query<{
      service_slug: string;
      service_status: string;
      version_status: string;
      version_id: string;
    }>(
      `SELECT service.slug AS service_slug,
              service.status AS service_status,
              version.status AS version_status,
              version.id AS version_id
       FROM mcp_services AS service
       JOIN mcp_service_versions AS version ON version.id = service.current_version_id
       WHERE service.id = $1`,
      [serviceId],
    );
    const row = result.rows[0];
    if (!row) return null;

    const promptResult = await this.#pool.query<{
      name: string;
      title: string | null;
      description: string | null;
      arguments: unknown;
    }>(
      `SELECT name, title, description, arguments
       FROM mcp_prompts
       WHERE version_id = $1
       ORDER BY position`,
      [row.version_id],
    );

    return {
      serviceSlug: row.service_slug,
      serviceStatus: ServiceStatusSchema.parse(row.service_status),
      versionStatus: VersionStatusSchema.parse(row.version_status),
      prompts: promptResult.rows.map((prompt) => ({
        name: prompt.name,
        ...(prompt.title === null ? {} : { title: prompt.title }),
        ...(prompt.description === null ? {} : { description: prompt.description }),
        arguments: (prompt.arguments as Array<{ name: string; required: boolean }>).map(
          (argument) => ({ name: argument.name, required: argument.required }),
        ),
      })),
    };
  }
}

export function createPostgresGatewayRepository(connectionString: string): {
  repository: PostgresGatewayRepository;
  close: () => Promise<void>;
} {
  const { pool, close } = createPostgresPool(connectionString);
  return {
    repository: new PostgresGatewayRepository(pool),
    close,
  };
}
