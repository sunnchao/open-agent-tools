/**
 * P0.3 冒烟：直接驱动 src/app/piRuntime.ts 全链路（流式/HITL/审计/usage）。
 * 运行：cd apps/cli && tsx scripts/pi-proto/smoke.ts
 */
import { config as loadEnv } from "dotenv";
import path from "node:path";
import os from "node:os";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPiRuntime } from "../../src/app/piRuntime.ts";
import { PermissionManager } from "../../src/tools/permissions.ts";
import { MemoryStore } from "../../src/store/memory.ts";
import type { StreamableAgentCallbacks } from "../../src/ui/agentCallbacks.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(__dirname, "../../.env.local") });

// 允许所有危险工具（不弹确认），验证 HITL 放行路径
const permissionManager = new PermissionManager(async () => "allow");
const audits: unknown[] = [];

// 隔离的记忆库（冒烟用临时目录）
const smokeRoot = path.join(os.tmpdir(), `pi-smoke-${Date.now()}`);
const memoryStore = new MemoryStore({
  cwd: smokeRoot,
  globalRoot: path.join(smokeRoot, "global-memory"),
  projectRoot: path.join(smokeRoot, "project-memory"),
});
memoryStore.open();

const runtime = await createPiRuntime({
  cwd: process.cwd(),
  onAudit: (entry) => {
    audits.push(entry);
    console.log(`[audit] ${entry.decision} ${entry.toolName} ${entry.argsSummary}`);
  },
  memoryStore,
  currentSessionId: () => "smoke-session",
  requestPermission: (name, args) => permissionManager.decide(name, args),
});

const callbacks: StreamableAgentCallbacks = {
  resetStream: () => {},
  startActivity: () => {},
  stopActivity: () => {},
  onReasoning: (t) => process.stdout.write(`[💭${t}]`),
  onToken: (t) => process.stdout.write(t),
  onUsage: (u) =>
    console.log(
      `\n[usage] input=${u.inputTokens} output=${u.outputTokens} reasoning=${u.reasoningTokens}`,
    ),
  onToolCall: (tc) => console.log(`\n[tool_call] ${tc.name}`),
  onToolStart: (tc) => console.log(`[tool_start] ${tc.name}`),
  onToolResult: (tc, result) => console.log(`[tool_result] ${tc.name} len=${result.length}`),
  onToolDenied: (tc) => console.log(`[tool_denied] ${tc.name}`),
  requestPermission: () => permissionManager.decide("bash", "{}"),
  onAudit: () => {},
};

const systemPrompt =
  "你是 CLI 冒烟验证代理。需要时间时调用 get_current_time，需要执行命令时用 bash。回答保持简洁。";

// 注入跨会话历史（P0.6 验证）：上一会话里用户自称"阿旺"。
await runtime.setHistory([
  { role: "user", content: "我的名字叫阿旺，请记住。" },
  { role: "assistant", content: "好的阿旺，我记住了。" },
]);
runtime.session?.subscribe((e) => {
  if (
    e.type === "tool_execution_start" ||
    e.type === "message_update" ||
    e.type === "turn_end" ||
    e.type === "agent_end"
  ) {
    console.log(`[event] ${e.type}`);
  }
});

console.log("=== Q1: 历史上下文（应引用「阿旺」） ===");
const a1 = await runtime.prompt("我叫什么名字？", { systemPrompt, callbacks });
console.log(`\n[answer1] ${JSON.stringify(a1)}`);

console.log("\n=== Q2: 查看当前目录文件（bash，HITL 放行） ===");
const a2 = await runtime.prompt("列出当前目录前 5 个条目。", { systemPrompt, callbacks });
console.log(`\n[answer2] ${a2.slice(0, 100)}`);

console.log("\n=== Q3: 记忆工具（memory_propose） ===");
const a3 = await runtime.prompt(
  "请用 memory_propose 提议一条记忆：用户阿旺的常用编程语言是 TypeScript。",
  { systemPrompt, callbacks },
);
console.log(`\n[answer3] ${a3.slice(0, 120)}`);
const pending = memoryStore.list({ limit: 10, includeUnreviewed: true });
console.log(
  "[memory entries]",
  JSON.stringify(
    pending.map((m) => ({ slug: m.slug, unreviewed: m.unreviewed, headline: m.headline })),
  ),
);

console.log("\n=== Q4: MCP 工具（echo，requirePermission 放行） ===");
console.log("[toolNames]", JSON.stringify(runtime.getToolNames()));
const a4 = await runtime.prompt('请调用 echo 工具，参数 value 填 "hello-mcp"。', {
  systemPrompt,
  callbacks,
});
console.log(`\n[answer4] ${a4.slice(0, 120)}`);

runtime.dispose();
memoryStore.close();
rmSync(smokeRoot, { recursive: true, force: true });
console.log("\n=== 审计记录 ===");
for (const a of audits) console.log(" -", JSON.stringify(a));
console.log("[done]");
