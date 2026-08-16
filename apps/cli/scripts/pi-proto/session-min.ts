/**
 * P0.2/P0.3 原型：createAgentSession 全链路 + tool_call 拦截（HITL block）验证。
 * 验证点：① createAgentSession 会话闭环 ② tool_call 事件拦截 + block 回灌行为
 * 运行：cd apps/cli && tsx scripts/pi-proto/session-min.ts
 */
import { config as loadEnv } from "dotenv";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  createAgentSession,
  defineTool,
  type ToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(__dirname, "../../.env.local") });

const baseUrl = process.env.OPENAI_API_BASE_URL;
const apiKey = process.env.OPENAI_API_KEY;
const modelId = process.env.OPENAI_API_MODEL || "Qwen3.6-35B-A3B";
if (!baseUrl || !apiKey) {
  console.error("缺少 OPENAI_API_BASE_URL / OPENAI_API_KEY（.env.local）");
  process.exit(1);
}

// 1. 模型运行时
const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
modelRuntime.registerProvider("openai-compatible", {
  name: "OpenAI Compatible",
  baseUrl,
  apiKey,
  api: "openai-completions",
  models: [
    {
      id: modelId,
      name: modelId,
      reasoning: true,
      input: ["text"],
      contextWindow: 128000,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStrictTools: false },
    },
  ],
});
const model = modelRuntime.getModel("openai-compatible", modelId);
if (!model) {
  console.error("model not found");
  process.exit(1);
}

// 2. 自定义工具：get_time
const getTimeTool: ToolDefinition = defineTool({
  name: "get_time",
  label: "获取当前时间",
  description: "获取当前 ISO 时间",
  parameters: Type.Object({}),
  execute: async () => ({
    content: [{ type: "text", text: new Date().toISOString() }],
    details: {},
  }),
});

// 3. HITL 扩展：bash 一律拦截拒绝，验证 block 回灌
const hitlExtension = (pi: ExtensionAPI) => {
  console.log("[hitl] 扩展已注册");
  pi.on("tool_call", async (event, _ctx) => {
    console.log(`[hitl] tool_call event: name=${event.toolName}`);
    if (event.toolName !== "bash") return;
    console.log(`[hitl] 拦截 bash, args=${JSON.stringify((event as { input: Record<string, unknown> }).input)}`);
    return { block: true, reason: "用户拒绝了 bash 调用（原型验证）", terminate: false };
  });
};

// 4. 资源加载器（含扩展 + 系统提示词覆盖）
const agentDir = path.join(os.tmpdir(), "pi-proto-agent");
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
const resourceLoader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir,
  settingsManager,
  extensionFactories: [hitlExtension],
  systemPrompt: "你是 CLI 原型验证代理。需要时间用 get_time。",
});
await resourceLoader.reload();

// 5. 会话
const { session } = await createAgentSession({
  cwd: process.cwd(),
  agentDir,
  model,
  modelRuntime,
  tools: ["bash", "get_time"],
  customTools: [getTimeTool],
  resourceLoader,
  sessionManager: SessionManager.inMemory(),
  settingsManager,
  thinkingLevel: "off",
});

session.subscribe((event) => {
  switch (event.type) {
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") process.stdout.write(event.assistantMessageEvent.delta);
      if (event.assistantMessageEvent.type === "thinking_delta") process.stdout.write(`[💭${event.assistantMessageEvent.delta}]`);
      break;
    case "tool_execution_start":
      console.log(`\n[tool_execution_start] ${event.toolName}`);
      break;
    case "tool_execution_end":
      console.log(`\n[tool_execution_end] ${event.toolName} isError=${event.isError}`);
      break;
    case "turn_end":
      console.log(`\n[turn_end] turn=${event.turnIndex}`);
      break;
    case "agent_end":
      console.log(`\n[agent_end] messages=${event.messages.length}`);
      break;
  }
});

console.log("=== prompt 1: 调用 bash（应被拦截） ===");
await session.prompt("帮我运行 ls 命令，列出当前目录。");

console.log("\n=== prompt 2: 调用 get_time（应成功） ===");
await session.prompt("现在几点了？调用 get_time 工具。");

console.log("\n=== 会话消息 ===");
for (const m of session.messages) {
  console.log(`  - ${m.role}: ${JSON.stringify((m as { content?: unknown }).content).slice(0, 120)}`);
}

session.dispose();
console.log("\n[done]");
