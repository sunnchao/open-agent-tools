import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ServerResponse } from "node:http";
import { afterEach, describe, it } from "node:test";
import type { RemoteServiceConfig } from "@open-agent-tools/mcp-contracts";
import { RemoteMcpError, RemoteMcpProxy } from "./remote-proxy.js";

interface StubCall {
  method: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: {
    jsonrpc?: string;
    id?: unknown;
    method?: string;
    params?: { name?: string; arguments?: Record<string, unknown> } & Record<string, unknown>;
  };
}

interface StubServer {
  url: string;
  calls: StubCall[];
  close: () => Promise<void>;
}

const openServers: StubServer[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

function startStub(handler: (call: StubCall, res: ServerResponse) => void): Promise<StubServer> {
  return new Promise((resolve) => {
    const calls: StubCall[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const call: StubCall = {
          method: request.method,
          headers: request.headers,
          body: text.length > 0 ? JSON.parse(text) : {},
        };
        calls.push(call);
        handler(call, response);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      const stub: StubServer = {
        url: `http://127.0.0.1:${port}/mcp`,
        calls,
        close: () => new Promise((done) => server.close(() => done())),
      };
      openServers.push(stub);
      resolve(stub);
    });
  });
}

function jsonResponse(
  res: ServerResponse,
  body: unknown,
  init: { status?: number; sessionId?: string; contentType?: string } = {},
): void {
  const headers: Record<string, string> = {
    "content-type": init.contentType ?? "application/json",
  };
  if (init.sessionId) headers["mcp-session-id"] = init.sessionId;
  res.writeHead(init.status ?? 200, headers);
  res.end(JSON.stringify(body));
}

/** 模拟一个标准 streamable-http MCP 上游。 */
function upstreamHandler(call: StubCall, res: ServerResponse): void {
  const { method, id } = call.body;
  if (method === "initialize") {
    jsonResponse(
      res,
      {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "upstream", version: "1.0.0" },
        },
      },
      { sessionId: "session-abc" },
    );
    return;
  }
  if (method === "notifications/initialized") {
    res.writeHead(202);
    res.end();
    return;
  }
  if (method === "tools/list") {
    jsonResponse(
      res,
      {
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "echo",
              description: "Echo the provided text",
              inputSchema: { type: "object", properties: { text: { type: "string" } } },
            },
            { name: "no_schema" },
            { description: "missing name" },
          ],
        },
      },
      { sessionId: "session-abc" },
    );
    return;
  }
  if (method === "tools/call") {
    const args = (call.body.params?.arguments ?? {}) as { text?: string };
    jsonResponse(
      res,
      {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: `echo:${String(args.text)}` }] },
      },
      { sessionId: "session-abc" },
    );
    return;
  }
  jsonResponse(res, { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
}

function config(url: string, overrides: Partial<RemoteServiceConfig> = {}): RemoteServiceConfig {
  return {
    transport: "streamable-http",
    url,
    timeoutMs: 5_000,
    ...overrides,
  };
}

describe("RemoteMcpProxy", () => {
  it("initializes once, lists tools, and reuses the upstream session", async () => {
    const stub = await startStub(upstreamHandler);
    const proxy = new RemoteMcpProxy(config(stub.url));

    const tools = await proxy.listTools();
    assert.deepEqual(tools, [
      {
        name: "echo",
        description: "Echo the provided text",
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
      },
      { name: "no_schema", inputSchema: { type: "object" } },
    ]);

    const result = await proxy.callTool("echo", { text: "hi" });
    assert.deepEqual(result, { content: [{ type: "text", text: "echo:hi" }] });

    const methods = stub.calls.map((call) => call.body.method);
    assert.deepEqual(methods, [
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
    // initialize 在建立会话前，不带 session；后续请求复用同一会话。
    assert.equal(stub.calls[0]?.headers["mcp-session-id"], undefined);
    assert.equal(stub.calls[2]?.headers["mcp-session-id"], "session-abc");
    assert.equal(stub.calls[3]?.headers["mcp-session-id"], "session-abc");
  });

  it("parses SSE (text/event-stream) responses", async () => {
    const stub = await startStub((call, res) => {
      const { method, id } = call.body;
      if (method === "initialize") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sse-1" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05" } }));
        return;
      }
      if (method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { tools: [{ name: "from_sse", inputSchema: { type: "object" } }] },
        })}\n\n`,
      );
    });

    const proxy = new RemoteMcpProxy(config(stub.url));
    assert.deepEqual(await proxy.listTools(), [
      { name: "from_sse", inputSchema: { type: "object" } },
    ]);
  });

  it("sends the bearer token and custom headers", async () => {
    const stub = await startStub(upstreamHandler);
    const proxy = new RemoteMcpProxy(
      config(stub.url, { token: "secret-token", headers: { "x-tenant": "acme" } }),
    );

    await proxy.listTools();
    assert.equal(stub.calls[0]?.headers.authorization, "Bearer secret-token");
    assert.equal(stub.calls[0]?.headers["x-tenant"], "acme");
  });

  it("throws RemoteMcpError on non-2xx responses", async () => {
    const stub = await startStub((_call, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "boom" }));
    });

    const proxy = new RemoteMcpProxy(config(stub.url));
    await assert.rejects(proxy.listTools(), (error: unknown) => {
      assert.ok(error instanceof RemoteMcpError);
      assert.match(error.message, /status 500/);
      return true;
    });
  });

  it("throws RemoteMcpError when the upstream returns a JSON-RPC error", async () => {
    const stub = await startStub((call, res) => {
      const { method, id } = call.body;
      if (method === "initialize") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05" } }));
        return;
      }
      if (method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }
      jsonResponse(res, {
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: "upstream unavailable" },
      });
    });

    const proxy = new RemoteMcpProxy(config(stub.url));
    await assert.rejects(proxy.listTools(), /upstream unavailable/);
  });

  it("aborts and throws RemoteMcpError when the upstream times out", async () => {
    const stub = await startStub((_call, res) => {
      setTimeout(() => {
        try {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
        } catch {
          // 客户端已因超时断开连接，忽略。
        }
      }, 200);
    });

    const proxy = new RemoteMcpProxy(config(stub.url, { timeoutMs: 30 }));
    await assert.rejects(proxy.listTools(), /timed out/);
  });
});
