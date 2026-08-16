/**
 * P1.1 冒烟：MCP 工具加载器（Pi defineTool 版）。
 * 依赖：本地 MCP Gateway 运行中（apps/mcp-server :4100），且 apps/cli/mcp.json 配置了 remote-mcp。
 * 运行：cd apps/cli && tsx scripts/pi-proto/mcp-smoke.ts
 */
import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMcpPiTools } from "../../src/tools/mcpPi.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(__dirname, "../../.env.local") });

const audits: unknown[] = [];
const mcp = await loadMcpPiTools(new Set(["read", "write", "edit", "bash"]), {
  requestPermission: async () => true,
  onAudit: (entry) => {
    audits.push(entry);
    console.log(`[audit] ${entry.decision} ${entry.source}:${entry.server}/${entry.toolName} ${entry.argsSummary}`);
  },
});

console.log("\n=== MCP 加载结果 ===");
for (const e of mcp.errors) console.log(`[warn] ${e}`);
console.log(`mcpToolNames: ${JSON.stringify(mcp.mcpToolNames)}`);
console.log(`toolServers: ${JSON.stringify(mcp.toolServers)}`);

const echo = mcp.tools.find((t) => t.name === "echo");
console.log(`\necho 工具已加载: ${!!echo}`);

if (echo) {
  console.log("\n=== 调用 echo ===");
  // defineTool 的 execute 签名 (toolCallId, params, signal, onUpdate, ctx)
  const result = await (echo as unknown as { execute: (id: string, args: unknown) => Promise<{ content: Array<{ text: string }> }> }).execute("call-1", { value: "hello pi" });
  console.log("[echo result]", JSON.stringify(result.content));
}

console.log("\n=== 审计记录 ===");
for (const a of audits) console.log(" -", JSON.stringify(a));

await mcp.cleanup();
console.log("[done]");
