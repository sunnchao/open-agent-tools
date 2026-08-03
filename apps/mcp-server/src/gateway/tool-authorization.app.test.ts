import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { test } from "node:test";

import { GatewayAccessService } from "./access.js";
import { createGatewayApp } from "./app.js";
import { createApiKey } from "./api-key.js";
import { InMemoryGatewayRepository } from "./repository.js";
import type { ToolExecutionRequest } from "./tool-executor.js";

const keyId1 = "018f5f8d-23f2-7ec7-a799-6f3988e86dd7";
const keyId2 = "028f5f8d-23f2-7ec7-a799-6f3988e86dd7";

test("token1 can list/call A and B while token2 can list/call only C", async () => {
  const [token1, token2] = await Promise.all([
    createApiKey(keyId1, () => Buffer.alloc(32, 1)),
    createApiKey(keyId2, () => Buffer.alloc(32, 2)),
  ]);
  const repository = new InMemoryGatewayRepository({
    clients: [
      { id: "client-1", status: "ACTIVE" },
      { id: "client-2", status: "ACTIVE" },
    ],
    keys: [
      {
        id: keyId1,
        clientId: "client-1",
        keyHash: token1.keyHash,
        status: "ACTIVE",
        expiresAt: null,
      },
      {
        id: keyId2,
        clientId: "client-2",
        keyHash: token2.keyHash,
        status: "ACTIVE",
        expiresAt: null,
      },
    ],
    grants: [
      {
        clientId: "client-1",
        serviceId: "service-1",
        scopes: ["mcp:connect", "tools:list", "tools:call"],
        promptNames: null,
        toolNames: ["A", "B"],
      },
      {
        clientId: "client-2",
        serviceId: "service-1",
        scopes: ["mcp:connect", "tools:list", "tools:call"],
        promptNames: null,
        toolNames: ["C"],
      },
    ],
    services: [
      {
        serviceId: "service-1",
        serviceSlug: "tools",
        serviceStatus: "ACTIVE",
        versionId: "version-1",
        versionStatus: "PUBLISHED",
        imageDigest: "sha256:published-image",
        limits: {
          timeoutMs: 30_000,
          memoryMb: 256,
          cpuMillis: 1_000,
          network: "none",
        },
        tools: ["A", "B", "C"].map((name) => ({
          name,
          handler: `tool${name}`,
          inputSchema: { type: "object", additionalProperties: false },
        })),
        prompts: [],
      },
    ],
  });
  const executions: ToolExecutionRequest[] = [];
  const app = createGatewayApp({
    access: new GatewayAccessService(repository),
    executor: {
      execute: async (request) => {
        executions.push(request);
        return { content: [{ type: "text", text: request.toolName }], isError: false };
      },
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp/services/tools`);
  const client1 = new Client({ name: "token-1-client", version: "1.0.0" });
  const client2 = new Client({ name: "token-2-client", version: "1.0.0" });

  try {
    await client1.connect(
      new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { authorization: `Bearer ${token1.rawKey}` } },
      }),
    );
    await client2.connect(
      new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { authorization: `Bearer ${token2.rawKey}` } },
      }),
    );

    assert.deepEqual(
      (await client1.listTools()).tools.map((tool) => tool.name),
      ["A", "B"],
    );
    assert.equal((await client1.callTool({ name: "A", arguments: {} })).isError, false);
    assert.equal((await client1.callTool({ name: "B", arguments: {} })).isError, false);
    await assert.rejects(client1.callTool({ name: "C", arguments: {} }), /not found/i);

    assert.deepEqual(
      (await client2.listTools()).tools.map((tool) => tool.name),
      ["C"],
    );
    assert.equal((await client2.callTool({ name: "C", arguments: {} })).isError, false);
    await assert.rejects(client2.callTool({ name: "A", arguments: {} }), /not found/i);

    assert.deepEqual(
      executions.map(({ context, toolName }) => ({ clientId: context.clientId, toolName })),
      [
        { clientId: "client-1", toolName: "A" },
        { clientId: "client-1", toolName: "B" },
        { clientId: "client-2", toolName: "C" },
      ],
    );
  } finally {
    await client1.close();
    await client2.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
