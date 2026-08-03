import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { after, before, beforeEach, describe, it } from "node:test";
import { Pool } from "pg";
import { GatewayAccessService } from "./access.js";
import { createGatewayApp } from "./app.js";
import { createApiKey } from "./api-key.js";
import { createPostgresGatewayRepository } from "./postgres-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const serviceId = "018f5f8d-23f2-7ec7-a799-6f3988e86dd1";
const versionId = "018f5f8d-23f2-7ec7-a799-6f3988e86dd2";
const clientId = "018f5f8d-23f2-7ec7-a799-6f3988e86dd3";
const keyId = "018f5f8d-23f2-7ec7-a799-6f3988e86dd4";
const grantId = "018f5f8d-23f2-7ec7-a799-6f3988e86dd5";
const promptId = "018f5f8d-23f2-7ec7-a799-6f3988e86dd6";
const now = "2026-07-31T12:00:00.000Z";

describe("PostgreSQL Prompt-only MCP Gateway E2E", { skip: !databaseUrl }, () => {
  let pool: Pool;
  let closeRepository: () => Promise<void>;
  let closeServer: () => Promise<void>;
  let baseUrl: string;
  let rawKey: string;

  before(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    for (const migrationName of ["0000_mcp_management.sql", "0001_mcp_client_access.sql"]) {
      const migration = await readFile(
        resolve(import.meta.dirname, `../../../mcp-control-plane/drizzle/${migrationName}`),
        "utf8",
      );
      await pool.query(migration);
    }

    const created = createPostgresGatewayRepository(databaseUrl!);
    closeRepository = created.close;
    const app = createGatewayApp({
      access: new GatewayAccessService(created.repository, { now: () => now }),
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolveListening, reject) => {
      server.once("listening", resolveListening);
      server.once("error", reject);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    closeServer = () => new Promise((resolveClose) => server.close(() => resolveClose()));
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE TABLE mcp_services, api_clients CASCADE");
    const created = await createApiKey(keyId, () => Buffer.alloc(32, 7));
    rawKey = created.rawKey;

    await pool.query(
      `INSERT INTO mcp_services
         (id, name, slug, type, status, revision, created_at, updated_at)
       VALUES ($1, 'Reports', 'reports', 'MANAGED_MCP', 'ACTIVE', 2, $2, $2)`,
      [serviceId, now],
    );
    await pool.query(
      `INSERT INTO mcp_service_versions
         (id, service_id, version_number, status, revision, created_at, updated_at)
       VALUES ($1, $2, 1, 'PUBLISHED', 4, $3, $3)`,
      [versionId, serviceId, now],
    );
    await pool.query(`UPDATE mcp_services SET current_version_id = $1 WHERE id = $2`, [
      versionId,
      serviceId,
    ]);
    await pool.query(
      `INSERT INTO mcp_prompts
         (id, version_id, name, title, description, arguments, messages, position)
       VALUES ($1, $2, 'summarize', 'Summarize', 'Create summary', $3::jsonb, $4::jsonb, 0)`,
      [
        promptId,
        versionId,
        JSON.stringify([{ name: "reportId", required: true }]),
        JSON.stringify([
          {
            role: "user",
            content: { type: "text", text: "Summarize {{reportId}}." },
          },
        ]),
      ],
    );
    await pool.query(
      `INSERT INTO api_clients (id, name, status, revision, created_at, updated_at)
       VALUES ($1, 'E2E client', 'ACTIVE', 1, $2, $2)`,
      [clientId, now],
    );
    await pool.query(
      `INSERT INTO api_keys (id, client_id, key_hash, status, created_at)
       VALUES ($1, $2, $3, 'ACTIVE', $4)`,
      [keyId, clientId, created.keyHash, now],
    );
    await pool.query(
      `INSERT INTO client_grants
         (id, client_id, service_id, scopes, prompt_names, tool_names, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NULL, NULL, $5, $5)`,
      [grantId, clientId, serviceId, ["mcp:connect", "prompts:list", "prompts:get"], now],
    );
  });

  after(async () => {
    await closeServer();
    await closeRepository();
    await pool.end();
  });

  function transport() {
    return new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/services/reports`), {
      requestInit: { headers: { authorization: `Bearer ${rawKey}` } },
    });
  }

  it("E2E-002 loads the published snapshot and renders without a Tool execution", async () => {
    const client = new Client({ name: "postgres-e2e", version: "1.0.0" });
    await client.connect(transport());

    const prompts = await client.listPrompts();
    assert.deepEqual(
      prompts.prompts.map((prompt) => prompt.name),
      ["summarize"],
    );
    const rendered = await client.getPrompt({
      name: "summarize",
      arguments: { reportId: "report-1" },
    });
    assert.equal(
      rendered.messages[0]?.content.type === "text" ? rendered.messages[0].content.text : null,
      "Summarize report-1.",
    );
    const usage = await pool.query<{ last_used_at: Date | null }>(
      "SELECT last_used_at FROM api_keys WHERE id = $1",
      [keyId],
    );
    assert.ok(usage.rows[0]?.last_used_at);
    await client.close();
  });

  it("AUTH-008 rejects the same raw key immediately after revocation", async () => {
    await pool.query("UPDATE api_keys SET status = 'REVOKED' WHERE id = $1", [keyId]);
    const client = new Client({ name: "postgres-e2e", version: "1.0.0" });

    await assert.rejects(client.connect(transport()), /UNAUTHORIZED|Unauthorized|401/);
  });

  it("E2E-003 lists granted services for a key via GET /mcp/services", async () => {
    const response = await fetch(`${baseUrl}/mcp/services`, {
      headers: { authorization: `Bearer ${rawKey}` },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      services: Array<{
        serviceSlug: string;
        serviceStatus: string;
        versionStatus: string;
        scopes: string[];
        prompts: Array<{
          name: string;
          title?: string;
          description?: string;
          arguments: Array<{ name: string; required: boolean }>;
        }>;
      }>;
    };
    assert.deepEqual(body.services.map((service) => service.serviceSlug), ["reports"]);
    assert.equal(body.services[0]?.serviceStatus, "ACTIVE");
    assert.equal(body.services[0]?.versionStatus, "PUBLISHED");
    assert.ok(body.services[0]?.scopes.includes("mcp:connect"));
    assert.deepEqual(body.services[0]?.prompts, [
      {
        name: "summarize",
        title: "Summarize",
        description: "Create summary",
        arguments: [{ name: "reportId", required: true }],
      },
    ]);
  });
});
