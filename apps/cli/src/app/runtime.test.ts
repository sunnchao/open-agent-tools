import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
  type StopReason,
  type Usage,
} from "@earendil-works/pi-ai";

function usage(input: number, output: number, totalCost: number): Usage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: input + output,
    cost: { input: totalCost, output: 0, cacheRead: 0, cacheWrite: 0, total: totalCost },
  };
}

function response(
  model: Model<Api>,
  text: string,
  stopReason: Exclude<StopReason, "pending">,
  responseUsage: Usage,
  errorMessage?: string,
) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: responseUsage,
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
  if (stopReason === "error" || stopReason === "aborted") {
    stream.push({ type: "error", reason: stopReason, error: message });
  } else {
    stream.push({ type: "done", reason: stopReason, message });
  }
  return stream;
}

it("Pi runtime 覆盖工具装配、会话重建、正文兜底与 overflow 恢复", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "cli-runtime-"));
  const mcpConfigPath = join(rootDir, "mcp.json");
  const previousMcpConfig = process.env.MCP_CONFIG;
  const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
  const previousOpenAiBaseUrl = process.env.OPENAI_API_BASE_URL;
  const previousReasoningEffort = process.env.OPENAI_API_REASONING_EFFORT;
  let runtime: Awaited<ReturnType<(typeof import("./runtime.ts"))["createRuntime"]>> | undefined;

  try {
    await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: [] }), "utf8");
    process.env.MCP_CONFIG = mcpConfigPath;
    process.env.OPENAI_API_KEY = "test-api-key";
    process.env.OPENAI_API_BASE_URL = "https://example.com/v1";
    process.env.OPENAI_API_REASONING_EFFORT = "off";
    const { createRuntime } = await import("./runtime.ts");

    runtime = await createRuntime();
    await runtime.rebuildTools();

    const toolNames = [...(runtime.cli.allToolNames ?? [])].sort();
    assert.deepEqual(toolNames, [
      "bash",
      "edit",
      "find",
      "get_current_time",
      "grep",
      "ls",
      "memory_daily_append",
      "memory_list",
      "memory_propose",
      "memory_read",
      "memory_search",
      "read",
      "task",
      "todo",
      "write",
    ]);
    // 危险工具名（Pi 命名）
    assert.equal(toolNames.includes("write"), true);
    assert.equal(toolNames.includes("edit"), true);
    assert.equal(toolNames.includes("bash"), true);
    // 无 MCP 配置时无 MCP 工具
    assert.equal(runtime.cli.mcpToolServers.size, 0);

    const initialSession = runtime.pi.session;
    assert.ok(initialSession);
    initialSession.prompt = async () => {
      initialSession.agent.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "非流式回答" }],
        api: initialSession.model?.api ?? "openai-completions",
        provider: initialSession.model?.provider ?? "openai-compatible",
        model: initialSession.model?.id ?? "test-model",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      });
    };
    const fallbackTokens: string[] = [];
    const fallbackAnswer = await runtime.pi.prompt("test", {
      systemPrompt: "test",
      callbacks: {
        resetStream: () => {},
        startActivity: () => {},
        stopActivity: () => {},
        onToken: (text) => fallbackTokens.push(text),
      },
    });
    assert.equal(fallbackAnswer, "非流式回答");
    assert.deepEqual(fallbackTokens, ["非流式回答"]);

    await runtime.pi.setHistory([
      { role: "user", content: "我叫阿旺" },
      { role: "assistant", content: "你好，阿旺" },
    ]);
    const loadedSession = runtime.pi.session;
    assert.notEqual(loadedSession, initialSession);
    assert.deepEqual(
      loadedSession?.messages.map((message) => message.role),
      ["user", "assistant"],
    );

    await runtime.rebuildTools();
    assert.notEqual(runtime.pi.session, loadedSession);
    assert.deepEqual(
      runtime.pi.session?.messages.map((message) => message.role),
      ["user", "assistant"],
    );

    await runtime.pi.setHistory([]);
    assert.equal(runtime.pi.session?.messages.length, 0);

    await runtime.pi.setHistory([
      { role: "user", content: `早期需求 ${"a".repeat(24_000)}` },
      { role: "assistant", content: `早期结论 ${"b".repeat(24_000)}` },
      { role: "user", content: `近期需求 ${"c".repeat(20_000)}` },
      { role: "assistant", content: `近期进展 ${"d".repeat(1_000)}` },
    ]);
    const compactionSession = runtime.pi.session;
    assert.ok(compactionSession?.model);

    const sessionEvents: string[] = [];
    const unsubscribe = compactionSession.subscribe((event) => {
      if (event.type === "compaction_start" || event.type === "compaction_end") {
        sessionEvents.push(`${event.type}:${event.reason}`);
      }
    });
    let streamCalls = 0;
    compactionSession.agent.streamFunction = (model) => {
      streamCalls += 1;
      if (streamCalls === 1) {
        return response(
          model,
          "",
          "error",
          usage(120_000, 0, 0.12),
          "Input exceeds the context window",
        );
      }
      if (streamCalls === 2) {
        return response(model, "可识别的压缩摘要", "stop", usage(600, 40, 0.03));
      }
      return response(model, "压缩后重试成功", "stop", usage(2_000, 100, 0.01));
    };

    const reportedUsage: Array<{
      inputTokens: number;
      outputTokens: number;
      reasoningTokens: number;
    }> = [];
    const retriedAnswer = await runtime.pi.prompt("继续完成", {
      systemPrompt: "test",
      callbacks: {
        resetStream: () => {},
        startActivity: () => {},
        stopActivity: () => {},
        onUsage: (value) => reportedUsage.push(value),
      },
    });
    unsubscribe();

    assert.equal(retriedAnswer, "压缩后重试成功");
    assert.equal(streamCalls, 3, "应依次调用原请求、摘要请求和一次自动重试");
    assert.deepEqual(sessionEvents, ["compaction_start:overflow", "compaction_end:overflow"]);
    const compactionEntry = compactionSession.sessionManager
      .getEntries()
      .find((entry) => entry.type === "compaction");
    assert.equal(compactionEntry?.summary, "可识别的压缩摘要");
    assert.equal(compactionEntry?.usage?.cost.total, 0.03);
    assert.deepEqual(reportedUsage, [
      { inputTokens: 122_600, outputTokens: 140, reasoningTokens: 0 },
    ]);
  } finally {
    runtime?.pi.dispose();
    runtime?.rl.close();
    runtime?.memoryStore.close();
    if (previousMcpConfig === undefined) delete process.env.MCP_CONFIG;
    else process.env.MCP_CONFIG = previousMcpConfig;
    if (previousOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiApiKey;
    if (previousOpenAiBaseUrl === undefined) delete process.env.OPENAI_API_BASE_URL;
    else process.env.OPENAI_API_BASE_URL = previousOpenAiBaseUrl;
    if (previousReasoningEffort === undefined) delete process.env.OPENAI_API_REASONING_EFFORT;
    else process.env.OPENAI_API_REASONING_EFFORT = previousReasoningEffort;
    await rm(rootDir, { recursive: true, force: true });
  }
});
