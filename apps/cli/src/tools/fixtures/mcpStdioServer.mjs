import { appendFileSync, writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const pidFile = process.env.MCP_TEST_PID_FILE;
const callLog = process.env.MCP_TEST_CALL_LOG;
if (pidFile) writeFileSync(pidFile, String(process.pid));

function recordCall(value) {
  if (callLog) appendFileSync(callLog, `${value}\n`);
}

const server = new McpServer({ name: "cli-mcp-test", version: "1.0.0" });

server.tool("echo", "Echo a value", { value: z.string() }, async ({ value }) => {
  recordCall(`echo:${value}`);
  return { content: [{ type: "text", text: `echo:${value}` }] };
});

server.tool("fail", "Return an MCP tool error", {}, async () => {
  recordCall("fail");
  return { content: [{ type: "text", text: "planned failure" }], isError: true };
});

server.tool("blocked", "Denied by ACL", {}, async () => {
  recordCall("blocked");
  return { content: [{ type: "text", text: "blocked" }] };
});

server.tool("unlisted", "Excluded by allowedTools", {}, async () => {
  recordCall("unlisted");
  return { content: [{ type: "text", text: "unlisted" }] };
});

await server.connect(new StdioServerTransport());
