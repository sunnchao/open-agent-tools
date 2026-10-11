import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AuditEvent } from "@open-agent-tools/observability/audit";
import { createGatewayApp } from "./app.js";
import { GatewayAccessService } from "./access.js";
import { createApiKey } from "./api-key.js";
import { InMemoryGatewayRepository } from "./repository.js";
import type { ToolExecutionRequest } from "./tool-executor.js";

describe("MCP Gateway audit", () => {
  let baseUrl: string;
  let rawKey: string;
  let close: () => Promise<void>;
  let events: AuditEvent[];
  let execution: ToolExecutionRequest | undefined;
  let toolError: boolean;

  beforeEach(async () => {
    events = [];
    execution = undefined;
    toolError = false;
    const keyId = "018f5f8d-23f2-7ec7-a799-6f3988e86dd7";
    const key = await createApiKey(keyId);
    rawKey = key.rawKey;
    const repository = new InMemoryGatewayRepository({
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
          scopes: ["mcp:connect", "tools:call", "tools:list"],
          toolNames: null,
          promptNames: null,
        },
      ],
      services: [
        {
          serviceId: "service-1",
          serviceSlug: "search",
          serviceStatus: "ACTIVE",
          versionId: "version-1",
          versionStatus: "PUBLISHED",
          imageDigest: `sha256:${"a".repeat(64)}`,
          limits: { timeoutMs: 30000, memoryMb: 256, cpuMillis: 1000, network: "bridge" },
          tools: [
            {
              name: "search",
              handler: "search",
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" }, apiKey: { type: "string" } },
              },
            },
          ],
          prompts: [],
        },
      ],
    });
    const app = createGatewayApp({
      access: new GatewayAccessService(repository),
      executor: {
        execute: async (request) => {
          execution = request;
          return {
            content: [{ type: "text", text: toolError ? "fetch failed" : "完整的搜索输出" }],
            isError: toolError,
          };
        },
      },
      audit: {
        record: async (event) => {
          events.push(event);
        },
      },
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  });
  afterEach(async () => {
    await close();
  });

  async function call(name = "search", authorized = true) {
    const response = await fetch(`${baseUrl}/mcp/services/search`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(authorized ? { authorization: `Bearer ${rawKey}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: { query: "MCP", apiKey: "private-provider-key" } },
      }),
    });
    const body = await response.json();
    return { response, body };
  }

  it("records complete MCP input/output and connects the audit ID to the execution job", async () => {
    const { response, body } = await call();
    assert.equal(response.status, 200);
    const event = events[0]!;
    assert.equal(event.action, "MCP tools/call");
    assert.equal(event.actorId, "client-1");
    assert.equal(event.actorRole, "client");
    assert.equal(event.requestId, execution?.requestId);
    assert.equal(response.headers.get("x-request-id"), event.requestId);
    assert.deepEqual(event.output, body);
    assert.equal(event.outcome, "SUCCEEDED");
    assert.equal((event.context as { limits: { network: string } }).limits.network, "bridge");
    assert.equal(JSON.stringify(event).includes(rawKey), false);
    assert.equal(JSON.stringify(event).includes("private-provider-key"), false);
    assert.equal(
      (event.input as { params: { arguments: { apiKey: string } } }).params.arguments.apiKey,
      "[REDACTED]",
    );
  });

  it("records a Tool isError result as failed even when HTTP status is 200", async () => {
    toolError = true;
    await call();
    assert.equal(events[0]?.statusCode, 200);
    assert.equal(events[0]?.outcome, "FAILED");
    assert.ok(JSON.stringify(events[0]?.output).includes("fetch failed"));
  });

  it("captures protocol errors and authentication failures", async () => {
    await call("missing");
    assert.equal(events[0]?.outcome, "FAILED");
    assert.ok(JSON.stringify(events[0]?.output).includes("not found"));
    await call("search", false);
    assert.equal(events[1]?.statusCode, 401);
    assert.equal(events[1]?.actorId, "unauthenticated");
    assert.equal(events[1]?.outcome, "FAILED");
  });
});
