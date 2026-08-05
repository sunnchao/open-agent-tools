import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import {
  BaseChatModel,
  type BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import { tool } from "@langchain/core/tools";
import type { InterruptOnConfig } from "langchain";
import { LocalShellBackend } from "deepagents";
import { z } from "zod";
import { Agent, type AgentCallbacks, type AgentOptions, type TokenUsage } from "./agent.ts";

/** 测试夹具：一个响应元素——纯文本，或带 tool_calls 的 AIMessage。 */
type TestResponse = string | AIMessage;

/**
 * 测试用 ChatModel：每次被调用按序推进 responses（越界时重复最后一个，保证文本阶段稳定），
 * 流式（_streamResponseChunks）与生成（_generate）两条路径行为一致，
 * bindTools 返回自身以保留序列状态。
 */
class TestChatModel extends BaseChatModel {
  private readonly responses: TestResponse[];
  private calls = 0;

  constructor(responses: TestResponse[], params?: BaseChatModelParams) {
    super(params ?? {});
    this.responses = responses;
  }

  override _llmType(): string {
    return "test-chat-model";
  }

  override bindTools(): this {
    // deepagents 会调用 bindTools(tools)；返回自身以保留响应序列。
    return this;
  }

  private next(): TestResponse {
    const index = Math.min(this.calls, this.responses.length - 1);
    this.calls += 1;
    return this.responses[index] ?? new AIMessage({ content: "" });
  }

  override async _generate(
    _messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    _runManager?: unknown,
  ): Promise<ChatResult> {
    const response = this.next();
    if (response instanceof AIMessage) {
      const text = typeof response.content === "string" ? response.content : "";
      return { generations: [{ message: response, text }] };
    }
    return {
      generations: [{ message: new AIMessage({ content: response }), text: response }],
    };
  }

  override async *_streamResponseChunks(
    _messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    _runManager?: unknown,
  ): AsyncGenerator<ChatGenerationChunk> {
    const response = this.next();
    if (response instanceof AIMessage) {
      // 模拟 OpenAI 兼容 API：reasoning_content 先于 content/tool_calls 以独立 chunk 到达
      const reasoning = (response.additional_kwargs as { reasoning_content?: unknown })
        .reasoning_content;
      if (typeof reasoning === "string" && reasoning) {
        yield new ChatGenerationChunk({
          message: new AIMessageChunk({
            content: "",
            additional_kwargs: { reasoning_content: reasoning },
          }),
          text: "",
        });
      }
      if (response.tool_calls?.length) {
        // 流式路径：把 tool_calls 转成 tool_call_chunks 逐块输出
        for (const tc of response.tool_calls) {
          yield new ChatGenerationChunk({
            message: new AIMessageChunk({
              content: "",
              tool_call_chunks: [
                { name: tc.name, args: JSON.stringify(tc.args), id: tc.id, index: 0 },
              ],
            }),
            text: "",
          });
        }
        if (response.usage_metadata) {
          yield new ChatGenerationChunk({
            message: new AIMessageChunk({ content: "", usage_metadata: response.usage_metadata }),
            text: "",
          });
        }
        return;
      }
      const text = typeof response.content === "string" ? response.content : "";
      yield new ChatGenerationChunk({
        message: new AIMessageChunk({ content: response.content }),
        text,
      });
      // 模拟 langchain-openai：流式末尾单独 yield 一个携带 usage_metadata 的空 content chunk
      if (response.usage_metadata) {
        yield new ChatGenerationChunk({
          message: new AIMessageChunk({ content: "", usage_metadata: response.usage_metadata }),
          text: "",
        });
      }
      return;
    }
    yield new ChatGenerationChunk({
      message: new AIMessageChunk({ content: response }),
      text: response,
    });
  }
}

const sampleTool = tool(async ({ value }: { value: string }) => `echo:${value}`, {
  name: "sample_tool",
  description: "test stub",
  schema: z.object({ value: z.string() }),
});

const mcpSampleTool = tool(async () => "mcp-result", {
  name: "mcp_sample_tool",
  description: "MCP test stub",
  schema: z.object({}),
  metadata: { mcpServer: "test-server" },
});

// 用户批准偏差：测试 INTERRUPT_ON 加入 sample_tool，使中断路径真实触发。
// 注意：显式标注类型，去掉 as const 的 readonly（Record 值含 InterruptOnConfig）。
const INTERRUPT_ON: Record<string, boolean | InterruptOnConfig> = {
  write_file: { allowedDecisions: ["approve", "reject"] },
  edit_file: { allowedDecisions: ["approve", "reject"] },
  execute: { allowedDecisions: ["approve", "reject"] },
  sample_tool: { allowedDecisions: ["approve", "reject"] },
};

function makeAgent(
  responses: TestResponse[],
  options: AgentOptions = { interruptOn: INTERRUPT_ON },
): { agent: Agent; history: BaseMessage[] } {
  const model = new TestChatModel(responses);
  const history = [new HumanMessage("hi")];
  const agent = new Agent(model, [sampleTool], options);
  return { agent, history };
}

describe("Agent.runTurn (deepagents)", () => {
  it("使用注入的 LocalShellBackend 执行内置 write_file 时写入临时根目录", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "deepagent-backend-"));
    const outputPath = join(rootDir, "backend-output.txt");

    try {
      const backend = await LocalShellBackend.create({
        rootDir,
        virtualMode: false,
        inheritEnv: true,
        timeout: 30,
      });
      const model = new TestChatModel([
        new AIMessage({
          content: "",
          tool_calls: [
            {
              name: "write_file",
              args: { file_path: outputPath, content: "written by deepagents" },
              id: "call_write_file",
            },
          ],
        }),
        "done",
      ]);
      const agent = new Agent(model, [], { backend });

      const answer = await agent.runTurn([new HumanMessage("write the file")], "system prompt");

      assert.equal(answer, "done");
      assert.equal(await readFile(outputPath, "utf8"), "written by deepagents");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("纯文本回复：返回文本并追加 assistant 消息到 history", async () => {
    const { agent, history } = makeAgent(["done"]);
    const answer = await agent.runTurn(history, "system prompt");
    assert.equal(answer, "done");
    assert.ok(history.some((m) => m.getType() === "ai"));
  });

  it("推理内容经 onReasoning 流式转发，不混入 onToken 文本", async () => {
    const { agent, history } = makeAgent([
      new AIMessage({
        content: "final answer",
        additional_kwargs: { reasoning_content: "第一步: 拆解问题\n第二步: 得出结论" },
      }),
    ]);
    const tokens: string[] = [];
    const reasoning: string[] = [];
    const answer = await agent.runTurn(history, "system prompt", {
      onToken: (text) => tokens.push(text),
      onReasoning: (text) => reasoning.push(text),
    });

    assert.equal(answer, "final answer");
    assert.deepEqual(tokens, ["final answer"]);
    assert.deepEqual(reasoning, ["第一步: 拆解问题\n第二步: 得出结论"]);
  });

  it("无推理内容时 onReasoning 不触发", async () => {
    const { agent, history } = makeAgent(["plain answer"]);
    const reasoning: string[] = [];
    await agent.runTurn(history, "system prompt", {
      onReasoning: (text) => reasoning.push(text),
    });
    assert.deepEqual(reasoning, []);
  });

  it("onUsage 汇总整轮 agentic loop 的 token 用量（含推理 token）", async () => {
    const { agent, history } = makeAgent([
      new AIMessage({
        content: "",
        tool_calls: [{ name: "sample_tool", args: { value: "x" }, id: "call_u1" }],
        usage_metadata: {
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
          output_token_details: { reasoning: 5 },
        },
      }),
      new AIMessage({
        content: "done",
        usage_metadata: {
          input_tokens: 80,
          output_tokens: 30,
          total_tokens: 110,
          output_token_details: { reasoning: 10 },
        },
      }),
    ]);
    const usages: TokenUsage[] = [];
    const answer = await agent.runTurn(history, "system prompt", {
      onUsage: (usage) => usages.push(usage),
    });

    assert.equal(answer, "done");
    assert.deepEqual(usages, [{ inputTokens: 180, outputTokens: 50, reasoningTokens: 15 }]);
  });

  it("无 usage 信息时不触发 onUsage", async () => {
    const { agent, history } = makeAgent(["plain"]);
    const usages: TokenUsage[] = [];
    await agent.runTurn(history, "system prompt", {
      onUsage: (usage) => usages.push(usage),
    });
    assert.deepEqual(usages, []);
  });

  it("危险工具调用被批准：触发 onToolCall/onToolStart/onToolResult 与 allowed 审计", async () => {
    const { agent, history } = makeAgent([
      new AIMessage({
        content: "",
        tool_calls: [{ name: "sample_tool", args: { value: "x" }, id: "call_1" }],
      }),
      "done",
    ]);
    const events: string[] = [];
    const audits: string[] = [];
    const cb: AgentCallbacks = {
      onToolCall: () => events.push("toolCall"),
      onToolStart: () => events.push("toolStart"),
      onToolResult: () => events.push("toolResult"),
      requestPermission: async () => true,
      onAudit: (e) => audits.push(`${e.toolName}:${e.decision}`),
    };
    const answer = await agent.runTurn(history, "system prompt", cb);
    assert.equal(answer, "done");
    assert.ok(events.includes("toolCall"));
    assert.ok(events.includes("toolStart"));
    assert.ok(events.includes("toolResult"));
    assert.ok(audits.includes("sample_tool:allowed"));
  });

  it("危险工具调用被拒绝：触发 onToolDenied 与 denied 审计，不执行工具", async () => {
    const { agent, history } = makeAgent([
      new AIMessage({
        content: "",
        tool_calls: [{ name: "sample_tool", args: { value: "x" }, id: "call_1" }],
      }),
      "done",
    ]);
    const events: string[] = [];
    const cb: AgentCallbacks = {
      onToolStart: () => events.push("toolStart"),
      onToolDenied: () => events.push("denied"),
      requestPermission: async () => false,
    };
    const answer = await agent.runTurn(history, "system prompt", cb);
    assert.equal(answer, "done");
    assert.ok(events.includes("denied"));
    assert.ok(!events.includes("toolStart"));
  });

  it("自动工具调用触发完整事件和 auto 审计，工具结果不混入文本 token", async () => {
    const { agent, history } = makeAgent(
      [
        new AIMessage({
          content: "",
          tool_calls: [{ name: "sample_tool", args: { value: "x" }, id: "call_auto" }],
        }),
        "done",
      ],
      { interruptOn: {} },
    );
    const events: string[] = [];
    const tokens: string[] = [];
    const audits: string[] = [];
    const cb: AgentCallbacks = {
      onToken: (text) => tokens.push(text),
      onToolCall: () => events.push("toolCall"),
      onToolStart: () => events.push("toolStart"),
      onToolResult: () => events.push("toolResult"),
      onAudit: (entry) => audits.push(`${entry.toolName}:${entry.decision}`),
    };

    const answer = await agent.runTurn(history, "system prompt", cb);

    assert.equal(answer, "done");
    assert.deepEqual(events, ["toolCall", "toolStart", "toolResult"]);
    assert.deepEqual(tokens, ["done"]);
    assert.deepEqual(audits, ["sample_tool:auto"]);
  });

  it("同一轮中的连续危险工具调用可逐次授权并恢复", async () => {
    const { agent, history } = makeAgent([
      new AIMessage({
        content: "",
        tool_calls: [{ name: "sample_tool", args: { value: "first" }, id: "call_first" }],
      }),
      new AIMessage({
        content: "",
        tool_calls: [{ name: "sample_tool", args: { value: "second" }, id: "call_second" }],
      }),
      "done",
    ]);
    const permissions: string[] = [];
    const results: string[] = [];
    const cb: AgentCallbacks = {
      requestPermission: async (_name, args) => {
        permissions.push(args);
        return true;
      },
      onToolResult: (_tc, result) => results.push(result),
    };

    const answer = await agent.runTurn(history, "system prompt", cb);

    assert.equal(answer, "done");
    assert.equal(permissions.length, 2);
    assert.deepEqual(results, ["echo:first", "echo:second"]);
  });

  it("MCP 工具由 wrapper 审计，Agent 不重复记录 auto 审计", async () => {
    const model = new TestChatModel([
      new AIMessage({
        content: "",
        tool_calls: [{ name: "mcp_sample_tool", args: {}, id: "call_mcp" }],
      }),
      "done",
    ]);
    const agent = new Agent(model, [mcpSampleTool]);
    const audits: string[] = [];

    const answer = await agent.runTurn([new HumanMessage("use MCP")], "system prompt", {
      onAudit: (entry) => audits.push(`${entry.source}:${entry.toolName}`),
    });

    assert.equal(answer, "done");
    assert.deepEqual(audits, []);
  });
});
