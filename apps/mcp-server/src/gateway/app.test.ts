import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";
import { GatewayAccessService } from "./access.js";
import { createGatewayApp } from "./app.js";
import { createApiKey } from "./api-key.js";
import { InMemoryGatewayRepository } from "./repository.js";

const keyId = "018f5f8d-23f2-7ec7-a799-6f3988e86dd7";

describe("stateless MCP Gateway HTTP", () => {
  let baseUrl: string;
  let rawKey: string;
  let closeServer: () => Promise<void>;

  beforeEach(async () => {
    const created = await createApiKey(keyId, () => Buffer.alloc(32, 7));
    rawKey = created.rawKey;
    const repository = new InMemoryGatewayRepository({
      clients: [{ id: "client-1", status: "ACTIVE" }],
      keys: [
        {
          id: keyId,
          clientId: "client-1",
          keyHash: created.keyHash,
          status: "ACTIVE",
          expiresAt: null,
        },
      ],
      grants: [
        {
          clientId: "client-1",
          serviceId: "service-1",
          scopes: ["mcp:connect", "prompts:list", "prompts:get"],
          promptNames: null,
          toolNames: null,
        },
      ],
      services: [
        {
          serviceId: "service-1",
          serviceSlug: "reports",
          serviceStatus: "ACTIVE",
          versionId: "version-1",
          versionStatus: "PUBLISHED",
          imageDigest: null,
          limits: null,
          tools: [],
          prompts: [
            {
              name: "summarize",
              arguments: [{ name: "reportId", required: true }],
              messages: [
                {
                  role: "user",
                  content: { type: "text", text: "Summarize {{reportId}}." },
                },
              ],
            },
          ],
        },
      ],
    });
    const app = createGatewayApp({
      access: new GatewayAccessService(repository),
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    closeServer = () => new Promise((resolve) => server.close(() => resolve()));
  });

  afterEach(async () => {
    await closeServer();
  });

  it("GW-001 completes initialize, prompts/list, and prompts/get over HTTP", async () => {
    const client = new Client({ name: "http-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}/mcp/services/reports`),
      {
        requestInit: { headers: { authorization: `Bearer ${rawKey}` } },
      },
    );
    await client.connect(transport);

    assert.deepEqual(
      (await client.listPrompts()).prompts.map((prompt) => prompt.name),
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
    await client.close();
  });

  it("AUTH-003 rejects missing credentials", async () => {
    const response = await fetch(`${baseUrl}/mcp/services/reports`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      }),
    });

    assert.equal(response.status, 401);
  });

  it("GW-002 returns MCP-compatible 405 responses for GET and DELETE", async () => {
    for (const method of ["GET", "DELETE"]) {
      const response = await fetch(`${baseUrl}/mcp/services/reports`, { method });
      assert.equal(response.status, 405);
      const body = (await response.json()) as { jsonrpc: string; error: { code: number } };
      assert.equal(body.jsonrpc, "2.0");
      assert.equal(body.error.code, -32_000);
    }
  });

  it("GW-015 returns granted services for GET /mcp/services", async () => {
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
        prompts: Array<{ name: string; arguments: Array<{ name: string; required: boolean }> }>;
      }>;
    };
    assert.deepEqual(body.services.map((service) => service.serviceSlug), ["reports"]);
    assert.equal(body.services[0]?.serviceStatus, "ACTIVE");
    assert.equal(body.services[0]?.versionStatus, "PUBLISHED");
    assert.ok(body.services[0]?.scopes.includes("mcp:connect"));
    assert.deepEqual(body.services[0]?.prompts, [
      {
        name: "summarize",
        arguments: [{ name: "reportId", required: true }],
      },
    ]);
  });

  it("GW-016 rejects missing credentials on GET /mcp/services", async () => {
    const response = await fetch(`${baseUrl}/mcp/services`);
    assert.equal(response.status, 401);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, "UNAUTHORIZED");
  });
});
