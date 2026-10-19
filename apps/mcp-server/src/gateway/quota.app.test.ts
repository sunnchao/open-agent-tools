import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { GatewayAccessService } from "./access.js";
import { createGatewayApp } from "./app.js";
import { createApiKey } from "./api-key.js";
import { GatewayQuotaService } from "./quota.js";
import { InMemoryGatewayRepository } from "./repository.js";
import type { ToolExecutionRequest } from "./tool-executor.js";

const keyId = "018f5f8d-23f2-7ec7-a799-6f3988e86dd7";

describe("MCP Gateway quotas and usage", () => {
  let baseUrl: string;
  let rawKey: string;
  let repository: InMemoryGatewayRepository;
  let close: () => Promise<void>;
  let executions: ToolExecutionRequest[];
  let now: string;

  before(async () => {
    now = "2026-07-31T12:00:00.000Z";
    executions = [];
    const key = await createApiKey(keyId, () => Buffer.alloc(32, 7));
    rawKey = key.rawKey;
    repository = new InMemoryGatewayRepository({
      clients: [{ id: "client-1", status: "ACTIVE" }],
      keys: [
        {
          id: keyId,
          clientId: "client-1",
          keyHash: key.keyHash,
          status: "ACTIVE",
          expiresAt: null,
        },
      ],
      grants: [
        {
          clientId: "client-1",
          serviceId: "service-1",
          scopes: ["mcp:connect", "tools:list", "tools:call"],
          toolNames: null,
          promptNames: null,
        },
      ],
      services: [
        {
          serviceId: "service-1",
          serviceSlug: "tools",
          serviceStatus: "ACTIVE",
          versionId: "version-1",
          versionStatus: "PUBLISHED",
          imageDigest: `sha256:${"a".repeat(64)}`,
          limits: { timeoutMs: 30_000, memoryMb: 256, cpuMillis: 1_000, network: "none" },
          tools: [
            {
              name: "echo",
              handler: "echo",
              inputSchema: { type: "object", additionalProperties: true },
            },
          ],
          prompts: [],
        },
      ],
      quotas: [{ clientId: "client-1", serviceId: null, qpsLimit: 2, dailyCallLimit: 0 }],
    });
    const app = createGatewayApp({
      access: new GatewayAccessService(repository, { now: () => now }),
      quota: new GatewayQuotaService(repository, { now: () => now }),
      executor: {
        execute: async (request) => {
          executions.push(request);
          return { content: [{ type: "text", text: "ok" }] };
        },
      },
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise((resolve) => server.close(() => resolve()));
  });

  after(async () => {
    await close();
  });

  beforeEach(() => {
    now = "2026-07-31T12:00:00.000Z";
    repository.usageEvents.clear();
    executions = [];
  });

  function transport() {
    return new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/services/tools`), {
      requestInit: { headers: { authorization: `Bearer ${rawKey}` } },
    });
  }

  it("rejects the third call in one QPS window with HTTP 429 and Retry-After before execution", async () => {
    const client = new Client({ name: "quota-test", version: "1.0.0" });
    await client.connect(transport());
    try {
      await client.callTool({ name: "echo", arguments: {} });
      await client.callTool({ name: "echo", arguments: {} });
      executions = [];
      const response = await fetch(`${baseUrl}/mcp/services/tools`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${rawKey}`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "echo", arguments: {} },
        }),
      });
      assert.equal(response.status, 429);
      assert.ok(Number(response.headers.get("retry-after")) >= 1);
      const body = (await response.json()) as { error: { code: string } };
      assert.equal(body.error.code, "RATE_LIMITED");
      assert.equal(executions.length, 0);
    } finally {
      await client.close();
    }
  });

  it("settles successful and failed executions into usage_events", async () => {
    const client = new Client({ name: "settlement-test", version: "1.0.0" });
    await client.connect(transport());
    try {
      const result = await client.callTool({ name: "echo", arguments: {} });
      assert.deepEqual(result.content, [{ type: "text", text: "ok" }]);
      const events = [...repository.usageEvents.values()];
      assert.ok(events.some((event) => event.status === "SUCCEEDED"));
    } finally {
      await client.close();
    }
  });

  it("settles authorization failures instead of leaving a permanent reservation", async () => {
    const response = await fetch(`${baseUrl}/mcp/services/tools`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${rawKey}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "not-granted", arguments: {} },
      }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { error?: unknown; result?: { isError?: boolean } };
    assert.ok(body.error || body.result?.isError);
    const events = [...repository.usageEvents.values()];
    assert.equal(events.length, 1);
    assert.equal(events[0]?.status, "FAILED");
  });

  it("settles invalid tool arguments as a failed usage event", async () => {
    repository.services.set("tools", {
      ...repository.services.get("tools")!,
      tools: [
        {
          name: "strict",
          handler: "strict",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          },
        },
      ],
    });
    const response = await fetch(`${baseUrl}/mcp/services/tools`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${rawKey}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "strict", arguments: { query: 42 } },
      }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { error?: unknown; result?: { isError?: boolean } };
    assert.ok(body.error || body.result?.isError);
    const events = [...repository.usageEvents.values()];
    assert.equal(events.length, 1);
    assert.equal(events[0]?.status, "FAILED");
  });
});
