import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { AuditEntry } from "../app/piRuntime.ts";
import { listConfiguredMcpServers, loadMcpPiTools } from "./mcpPi.ts";

const fixturePath = fileURLToPath(new URL("./fixtures/mcpStdioServer.mjs", import.meta.url));

async function executeTool(tool: ToolDefinition, args: Record<string, unknown>): Promise<string> {
  const result = await tool.execute("test-call", args as never, undefined, undefined, {} as never);
  return result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(isProcessAlive(pid), false, `MCP 子进程 ${pid} 应在 cleanup 后退出`);
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("MCP_CONFIG 在 dotenv 加载后设置仍会生效", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mcp-config-"));
  const configPath = join(cwd, "custom-mcp.json");
  const previous = process.env.MCP_CONFIG;
  try {
    await writeFile(
      configPath,
      JSON.stringify({ mcpServers: [{ name: "dynamic", transport: "stdio", command: "node" }] }),
      "utf8",
    );
    process.env.MCP_CONFIG = configPath;
    assert.deepEqual(listConfiguredMcpServers(), [{ name: "dynamic", trust: "confirm" }]);
  } finally {
    if (previous === undefined) delete process.env.MCP_CONFIG;
    else process.env.MCP_CONFIG = previous;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("stdio MCP 覆盖 ACL、fail-closed 授权、结果审计与 cleanup", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mcp-stdio-"));
  const configPath = join(cwd, "mcp.json");
  const pidPath = join(cwd, "server.pid");
  const callLogPath = join(cwd, "calls.log");
  const previous = process.env.MCP_CONFIG;
  let deniedLoad: Awaited<ReturnType<typeof loadMcpPiTools>> | undefined;
  let allowedLoad: Awaited<ReturnType<typeof loadMcpPiTools>> | undefined;
  const config = {
    mcpServers: [
      {
        name: "fixture",
        transport: "stdio",
        command: process.execPath,
        args: [fixturePath],
        env: { MCP_TEST_PID_FILE: pidPath, MCP_TEST_CALL_LOG: callLogPath },
        trust: "trusted",
        requirePermission: true,
        allowedTools: ["echo", "fail", "blocked"],
        deniedTools: ["blocked"],
      },
    ],
  };

  try {
    await writeFile(configPath, JSON.stringify(config), "utf8");
    process.env.MCP_CONFIG = configPath;

    const deniedAudits: AuditEntry[] = [];
    deniedLoad = await loadMcpPiTools(new Set(), {
      onAudit: (entry) => deniedAudits.push(entry),
    });
    assert.deepEqual(deniedLoad.tools.map((tool) => tool.name).sort(), ["echo", "fail"]);
    assert.deepEqual(deniedLoad.toolServers, [
      { name: "echo", server: "fixture" },
      { name: "fail", server: "fixture" },
    ]);
    assert.deepEqual(deniedLoad.errors, []);
    assert.match(await executeTool(deniedLoad.tools[0]!, { value: "denied" }), /用户拒绝/);
    assert.deepEqual(deniedAudits, [
      {
        source: "mcp",
        server: "fixture",
        toolName: "echo",
        decision: "denied",
        argsSummary: '{"value":"denied"}',
        error: "permission denied",
      },
    ]);
    await assert.rejects(readFile(callLogPath, "utf8"), /ENOENT/);
    const deniedPid = Number(await readFile(pidPath, "utf8"));
    await deniedLoad.cleanup();
    deniedLoad = undefined;
    await waitForProcessExit(deniedPid);

    const audits: AuditEntry[] = [];
    allowedLoad = await loadMcpPiTools(new Set(), {
      requestPermission: async () => true,
      onAudit: (entry) => audits.push(entry),
    });
    const echo = allowedLoad.tools.find((tool) => tool.name === "echo");
    const fail = allowedLoad.tools.find((tool) => tool.name === "fail");
    assert.ok(echo);
    assert.ok(fail);
    assert.equal(await executeTool(echo, { value: "approved" }), "echo:approved");
    assert.match(await executeTool(fail, {}), /planned failure/);
    assert.deepEqual(audits, [
      {
        source: "mcp",
        server: "fixture",
        toolName: "echo",
        decision: "allowed",
        argsSummary: '{"value":"approved"}',
        error: null,
      },
      {
        source: "mcp",
        server: "fixture",
        toolName: "fail",
        decision: "allowed",
        argsSummary: "{}",
        error: "planned failure",
      },
    ]);
    assert.equal(await readFile(callLogPath, "utf8"), "echo:approved\nfail\n");
    const allowedPid = Number(await readFile(pidPath, "utf8"));
    await allowedLoad.cleanup();
    allowedLoad = undefined;
    await waitForProcessExit(allowedPid);
  } finally {
    await deniedLoad?.cleanup();
    await allowedLoad?.cleanup();
    if (previous === undefined) delete process.env.MCP_CONFIG;
    else process.env.MCP_CONFIG = previous;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Streamable HTTP MCP 覆盖 bearer token、调用审计与 cleanup", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "mcp-http-"));
  const configPath = join(cwd, "mcp.json");
  const previous = process.env.MCP_CONFIG;
  const authorizations: Array<string | undefined> = [];
  let loaded: Awaited<ReturnType<typeof loadMcpPiTools>> | undefined;

  const httpServer = createServer(async (request, response) => {
    authorizations.push(request.headers.authorization);
    if (request.headers.authorization !== "Bearer test-token") {
      response.writeHead(401).end();
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    const mcpServer = new McpServer({ name: "http-fixture", version: "1.0.0" });
    mcpServer.tool("http_echo", "Echo over HTTP", { value: z.string() }, async ({ value }) => ({
      content: [{ type: "text", text: `http:${value}` }],
    }));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    response.on("close", () => {
      void transport.close();
      void mcpServer.close();
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(request, response, body);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once("listening", resolve);
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1");
    });
    const port = (httpServer.address() as AddressInfo).port;
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: [
          {
            name: "http-fixture",
            transport: "http",
            url: `http://127.0.0.1:${port}/mcp`,
            token: "test-token",
            trust: "trusted",
          },
        ],
      }),
      "utf8",
    );
    process.env.MCP_CONFIG = configPath;

    const audits: AuditEntry[] = [];
    loaded = await loadMcpPiTools(new Set(), { onAudit: (entry) => audits.push(entry) });
    assert.deepEqual(loaded.errors, []);
    assert.deepEqual(loaded.toolServers, [{ name: "http_echo", server: "http-fixture" }]);
    const echo = loaded.tools.find((tool) => tool.name === "http_echo");
    assert.ok(echo);
    assert.equal(await executeTool(echo, { value: "ok" }), "http:ok");
    assert.deepEqual(audits, [
      {
        source: "mcp",
        server: "http-fixture",
        toolName: "http_echo",
        decision: "auto",
        argsSummary: '{"value":"ok"}',
        error: null,
      },
    ]);
    assert.ok(authorizations.length >= 3);
    assert.ok(authorizations.every((value) => value === "Bearer test-token"));

    await loaded.cleanup();
    loaded = undefined;
    await assert.rejects(executeTool(echo, { value: "after-cleanup" }));
    assert.equal(typeof audits.at(-1)?.error, "string");
  } finally {
    await loaded?.cleanup();
    await closeHttpServer(httpServer);
    if (previous === undefined) delete process.env.MCP_CONFIG;
    else process.env.MCP_CONFIG = previous;
    await rm(cwd, { recursive: true, force: true });
  }
});
