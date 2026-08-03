import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, it, test } from "node:test";
import type { AuthorizedService } from "./access.js";
import { createManagedMcpServer } from "./managed-server.js";
import type { ToolExecutionRequest, ToolExecutor } from "./tool-executor.js";

const access: AuthorizedService = {
  clientId: "client-1",
  scopes: new Set(["mcp:connect", "prompts:list", "prompts:get"]),
  promptNames: null,
  toolNames: null,
  snapshot: {
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
        name: "summarize_report",
        title: "Summarize report",
        description: "Create a summary request",
        arguments: [{ name: "reportId", description: "Report id", required: true }],
        messages: [
          {
            role: "user",
            content: { type: "text", text: "Summarize {{reportId}}." },
          },
        ],
      },
      {
        name: "private_prompt",
        arguments: [],
        messages: [{ role: "user", content: { type: "text", text: "Private" } }],
      },
    ],
  },
};

describe("managed MCP Prompt server", () => {
  let client: Client;
  let close: () => Promise<void>;

  beforeEach(() => {
    client = new Client({ name: "test-client", version: "1.0.0" });
  });

  afterEach(async () => {
    await close?.();
  });

  async function connect(authorized: AuthorizedService): Promise<void> {
    const server = createManagedMcpServer(authorized);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    close = async () => {
      await client.close();
      await server.close();
    };
  }

  it("GW-001, GW-007, and GW-008 initialize, list, and render the published Prompt", async () => {
    await connect(access);

    assert.ok(client.getServerCapabilities()?.prompts);
    const listed = await client.listPrompts();
    assert.deepEqual(listed.prompts[0], {
      name: "summarize_report",
      title: "Summarize report",
      description: "Create a summary request",
      arguments: [{ name: "reportId", description: "Report id", required: true }],
    });
    const rendered = await client.getPrompt({
      name: "summarize_report",
      arguments: { reportId: "report-1" },
    });
    assert.equal(rendered.messages[0]?.content.type, "text");
    assert.equal(
      rendered.messages[0]?.content.type === "text" ? rendered.messages[0].content.text : null,
      "Summarize report-1.",
    );
  });

  it("AUTH-006 rejects prompts/list and prompts/get independently by scope", async () => {
    await connect({ ...access, scopes: new Set(["mcp:connect", "prompts:get"]) });
    await assert.rejects(client.listPrompts(), /prompts:list/);
    await close();

    client = new Client({ name: "test-client", version: "1.0.0" });
    await connect({ ...access, scopes: new Set(["mcp:connect", "prompts:list"]) });
    await assert.rejects(
      client.getPrompt({ name: "summarize_report", arguments: { reportId: "report-1" } }),
      /prompts:get/,
    );
  });

  it("AUTH-007 filters listed and gettable Prompt names", async () => {
    await connect({ ...access, promptNames: new Set(["summarize_report"]) });

    const listed = await client.listPrompts();
    assert.deepEqual(
      listed.prompts.map((prompt) => prompt.name),
      ["summarize_report"],
    );
    await assert.rejects(client.getPrompt({ name: "private_prompt" }), /not found/);
  });

  it("PRM-008 and PRM-009 return protocol-safe argument errors", async () => {
    await connect(access);

    await assert.rejects(client.getPrompt({ name: "summarize_report" }), /reportId/);
    await assert.rejects(
      client.getPrompt({
        name: "summarize_report",
        arguments: { reportId: "report-1", unknown: "x" },
      }),
      /unknown/,
    );
  });
});

describe("managed MCP Tool server", () => {
  let client: Client;
  let close: () => Promise<void>;
  let requests: ToolExecutionRequest[];

  const toolAccess: AuthorizedService = {
    ...access,
    scopes: new Set(["mcp:connect", "tools:list", "tools:call"]),
    snapshot: {
      ...access.snapshot,
      imageDigest: "sha256:published-image",
      limits: {
        timeoutMs: 30_000,
        memoryMb: 256,
        cpuMillis: 1_000,
        network: "none",
      },
      tools: [
        {
          name: "get_report",
          description: "Get a report",
          handler: "getReport",
          inputSchema: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
            additionalProperties: false,
          },
        },
        {
          name: "private_tool",
          handler: "privateTool",
          inputSchema: { type: "object", additionalProperties: false },
        },
      ],
      prompts: [],
    },
  };

  beforeEach(async () => {
    requests = [];
    client = new Client({ name: "tool-test-client", version: "1.0.0" });
    const executor: ToolExecutor = {
      execute: async (request) => {
        requests.push(request);
        return {
          content: [{ type: "text", text: `report:${String(request.arguments.id)}` }],
        };
      },
    };
    const server = createManagedMcpServer(toolAccess, {
      executor,
      createRequestId: () => "request-1",
      now: () => "2026-07-31T12:00:00.000Z",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    close = async () => {
      await client.close();
      await server.close();
    };
  });

  afterEach(async () => {
    await close?.();
  });

  it("GW-004 and GW-006 list and invoke a Tool pinned to the published image", async () => {
    assert.ok(client.getServerCapabilities()?.tools);
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name),
      ["get_report", "private_tool"],
    );

    const result = await client.callTool({ name: "get_report", arguments: { id: "report-1" } });

    assert.deepEqual(result.content, [{ type: "text", text: "report:report-1" }]);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0], {
      requestId: "request-1",
      serviceId: "service-1",
      versionId: "version-1",
      imageDigest: "sha256:published-image",
      toolName: "get_report",
      arguments: { id: "report-1" },
      context: {
        clientId: "client-1",
        deadlineAt: "2026-07-31T12:00:30.000Z",
      },
      limits: toolAccess.snapshot.limits,
    });
  });

  it("GW-006 rejects invalid arguments before creating an execution", async () => {
    await assert.rejects(
      client.callTool({ name: "get_report", arguments: { id: 42 } }),
      /Invalid Tool arguments/,
    );
    assert.equal(requests.length, 0);
  });
});

test("AUTH-005 and AUTH-007 enforce Tool scopes and name filters", async () => {
  const requests: ToolExecutionRequest[] = [];
  const executor: ToolExecutor = {
    execute: async (request) => {
      requests.push(request);
      return { content: [] };
    },
  };
  const filteredAccess: AuthorizedService = {
    ...access,
    scopes: new Set(["mcp:connect", "tools:list"]),
    toolNames: new Set(["get_report"]),
    snapshot: {
      ...access.snapshot,
      imageDigest: "sha256:published-image",
      limits: {
        timeoutMs: 30_000,
        memoryMb: 256,
        cpuMillis: 1_000,
        network: "none",
      },
      tools: [
        {
          name: "get_report",
          handler: "getReport",
          inputSchema: { type: "object", additionalProperties: false },
        },
        {
          name: "private_tool",
          handler: "privateTool",
          inputSchema: { type: "object", additionalProperties: false },
        },
      ],
      prompts: [],
    },
  };
  const server = createManagedMcpServer(filteredAccess, { executor });
  const client = new Client({ name: "filtered-tool-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name),
      ["get_report"],
    );
    await assert.rejects(client.callTool({ name: "get_report", arguments: {} }), /tools:call/);
    await assert.rejects(client.callTool({ name: "private_tool", arguments: {} }), /tools:call/);
    assert.equal(requests.length, 0);
  } finally {
    await client.close();
    await server.close();
  }
});
