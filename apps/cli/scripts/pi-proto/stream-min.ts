/**
 * P0.2 原型：pi-ai → OpenAI 兼容网关最小流式调用验证。
 * 验证点：① thinking_delta / reasoning_content 映射 ② done 事件的 usage 字段。
 * 运行：cd apps/cli && tsx scripts/pi-proto/stream-min.ts
 */
import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(__dirname, "../../.env.local") });

const baseUrl = process.env.OPENAI_API_BASE_URL;
const apiKey = process.env.OPENAI_API_KEY;
const modelId = process.env.OPENAI_API_MODEL || "Qwen3.6-35B-A3B";

if (!baseUrl || !apiKey) {
  console.error("缺少 OPENAI_API_BASE_URL / OPENAI_API_KEY（.env.local）");
  process.exit(1);
}
console.log(`[config] baseUrl=${baseUrl} model=${modelId}`);

const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
runtime.registerProvider("openai-compatible", {
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
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        supportsStrictTools: false,
      },
    },
  ],
});

const model = runtime.getModel("openai-compatible", modelId);
if (!model) {
  console.error(`[error] model not found: ${modelId}`);
  console.log("[hint] 可能需要 runtime.refresh() 或检查 modelsPath 配置");
  process.exit(1);
}

const context = {
  systemPrompt: "你是一个简洁的助手。需要知道当前时间时请调用 get_time 工具。",
  messages: [
    { role: "user", content: "现在几点了？请调用 get_time 工具获取。", timestamp: Date.now() },
  ],
  tools: [
    {
      name: "get_time",
      description: "获取当前 ISO 时间",
      parameters: Type.Object({}),
    },
  ],
};

let text = "";
let thinking = "";
let toolCalls = 0;
let sawUsage = false;
let rounds = 0;

// 工具调用循环：done.reason === "toolUse" 时把 assistant + toolResult 回灌再跑一轮
while (rounds < 5) {
  let needsFollowUp = false;
  const stream = runtime.stream(model, context, {
    reasoning: "medium",
    onPayload: (payload) => {
      const sanitized = JSON.parse(JSON.stringify(payload));
      if (sanitized.messages) {
        sanitized.messages = sanitized.messages.map((message: { content: unknown }) => ({
          ...message,
          content: String(message.content).slice(0, 80),
        }));
      }
      delete sanitized.max_tokens;
      delete sanitized.max_completion_tokens;
      console.log("[payload]", JSON.stringify(sanitized).slice(0, 600));
    },
  });

  for await (const event of stream) {
    switch (event.type) {
      case "start":
        rounds += 1;
        console.log(`\n[round ${rounds} start] model=`, event.partial.model);
        break;
      case "text_delta":
        text += event.delta;
        process.stdout.write(event.delta);
        break;
      case "thinking_start":
        console.log("\n[thinking_start]");
        break;
      case "thinking_delta":
        thinking += event.delta;
        break;
      case "thinking_end":
        console.log("\n[thinking_end] thinking_len=", thinking.length);
        break;
      case "toolcall_start":
        toolCalls += 1;
        console.log(`\n[toolcall_start] name=${event.partial.content[event.contentIndex]?.name}`);
        break;
      case "toolcall_end": {
        const call = event.toolCall;
        console.log(`\n[toolcall_end] name=${call.name} args=${JSON.stringify(call.arguments)}`);
        break;
      }
      case "done": {
        sawUsage = true;
        const message = event.message;
        console.log("\n[done] reason=", event.reason, "stopReason=", message.stopReason);
        console.log("[usage]", JSON.stringify(message.usage));
        if (event.reason === "toolUse") {
          needsFollowUp = true;
          context.messages.push(message);
          for (const call of message.content.filter(
            (content): content is Extract<(typeof message.content)[number], { type: "toolCall" }> =>
              content.type === "toolCall",
          )) {
            context.messages.push({
              role: "toolResult",
              toolCallId: call.id,
              toolName: call.name,
              content: [{ type: "text", text: new Date().toISOString() }],
              timestamp: Date.now(),
            });
          }
        }
        break;
      }
      case "error":
        console.error("\n[error] reason=", event.reason, "errorMessage=", event.error.errorMessage);
        break;
    }
    if (event.type === "done" || event.type === "error") break;
  }
  if (!needsFollowUp) break;
}

console.log("\n--- 汇总 ---");
console.log("rounds:", rounds);
console.log("text_len:", text.length);
console.log("thinking_len:", thinking.length);
console.log("toolCalls:", toolCalls);
console.log("sawUsage:", sawUsage);
