import {
  AIMessage,
  SystemMessage,
  ToolMessage,
  AIMessageChunk,
  type BaseMessage,
} from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { Command, MemorySaver, INTERRUPT, isInterrupted } from "@langchain/langgraph";
import type { HITLRequest, InterruptOnConfig } from "langchain";
import { createDeepAgent, StateBackend, type AnyBackendProtocol } from "deepagents";
import { contentToString, dumpLlmIO } from "./utils.ts";
import { DANGEROUS_TOOLS } from "./constants.ts";

export interface ToolCallLike {
  name?: string;
  args?: unknown;
  id?: string;
}

/** 一轮对话（含内部多轮模型调用）的 token 用量汇总。 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface AgentCallbacks {
  /** 流式输出助手文本片段。 */
  onToken?: (text: string) => void;
  /** 流式输出模型推理片段（OpenAI 兼容 API 的 reasoning_content），与 content 互斥分段到达。 */
  onReasoning?: (text: string) => void;
  /** 一轮对话结束时的 token 用量汇总（agentic loop 内所有模型调用累加）。 */
  onUsage?: (usage: TokenUsage) => void;
  /** 模型决定调用某工具。 */
  onToolCall?: (tc: ToolCallLike) => void;
  /** 工具执行完成（成功/失败均触发）。 */
  onToolResult?: (tc: ToolCallLike, resultText: string) => void;
  /** 工具鉴权通过、即将执行时触发（用于在执行期显示 loading）。 */
  onToolStart?: (tc: ToolCallLike) => void;
  /** 用户拒绝了危险工具调用。 */
  onToolDenied?: (tc: ToolCallLike) => void;
  /** 危险工具运行前请求授权，返回 true 放行 / false 拒绝。 */
  requestPermission?: (name: string, args: string) => Promise<boolean>;
  /** 工具调用审计（决策记录）。 */
  onAudit?: (entry: {
    source: "builtin" | "mcp";
    server: string | null;
    toolName: string;
    decision: "allowed" | "denied" | "auto";
    argsSummary: string;
  }) => void;
}

export type AgentBackend = AnyBackendProtocol;

export interface AgentOptions {
  /** 工具名 → 是否中断/中断策略。默认只对危险工具中断。 */
  interruptOn?: Record<string, boolean | InterruptOnConfig>;
  /** 文件系统/执行后端；缺省为 StateBackend（内存）。 */
  backend?: AgentBackend;
}

/** 危险工具名（deepagents 内置名），用于 /tools 展示与授权提示。 */
export const DANGEROUS_TOOL_NAMES = DANGEROUS_TOOLS;

/**
 * deepagents 适配器：保持旧 runTurn 契约，内部由 LangGraph 驱动的 Deep Agent 执行。
 * - 每轮独立 thread_id（MemorySaver 仅用于轮内 interrupt/resume 状态）。
 * - 多模式流式（messages + values）渲染 token / 工具事件；interrupt 从 values chunk 提取。
 * - 授权通过 PermissionManager（经 callbacks.requestPermission），拒绝决策回灌给模型。
 */
export class Agent {
  private readonly agent: ReturnType<typeof createDeepAgent>;
  private readonly checkpointer: MemorySaver;
  private readonly interruptOn: Record<string, boolean | InterruptOnConfig>;
  private readonly mcpToolNames: ReadonlySet<string>;

  constructor(model: BaseChatModel, tools: StructuredToolInterface[], options: AgentOptions = {}) {
    this.checkpointer = new MemorySaver();
    this.interruptOn = options.interruptOn ?? {};
    this.mcpToolNames = new Set(
      tools
        .filter((candidate) => {
          const metadata = (candidate as { metadata?: Record<string, unknown> }).metadata;
          return typeof metadata?.mcpServer === "string";
        })
        .map((candidate) => candidate.name),
    );
    this.agent = createDeepAgent({
      model,
      // 只传自定义工具（MCP / 时间 / 记忆）；fs/shell/todo/task 由内置 middleware 提供。
      tools: tools as never,
      backend: options.backend ?? new StateBackend(),
      checkpointer: this.checkpointer,
      interruptOn: this.interruptOn,
    });
  }

  /**
   * 执行一轮对话。history 会被原地修改（追加本轮 assistant / tool 消息）以保留跨轮上下文。
   * 返回最终的助手文本回复。
   */
  async runTurn(
    history: BaseMessage[],
    systemPrompt: string,
    cb: AgentCallbacks = {},
  ): Promise<string> {
    const threadId = crypto.randomUUID();
    const config = { configurable: { thread_id: threadId } };
    const inputMessages: BaseMessage[] = [new SystemMessage(systemPrompt), ...history];

    let answer = "";
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
    const toolCallChunks = new Map<string, AIMessageChunk>();
    const announcedToolCalls = new Set<string>();
    let nextInput: { messages: BaseMessage[] } | Command = { messages: inputMessages };

    while (true) {
      let hitl: HITLRequest | undefined;
      const stream = (await this.agent.stream(nextInput, {
        ...config,
        streamMode: ["messages", "values"],
        subgraphs: true,
      } as never)) as unknown as AsyncIterable<StreamTriple>;

      for await (const [namespace, mode, data] of stream) {
        if (mode === "values" && isInterrupted(data)) {
          hitl = (data[INTERRUPT] as Array<{ value: HITLRequest }>)[0]?.value;
          continue;
        }
        if (mode !== "messages") continue;

        const message = (data as [BaseMessage, unknown])[0];
        const streamKey = namespace.join("/");
        if (ToolMessage.isInstance(message)) {
          toolCallChunks.delete(streamKey);
          cb.onToolResult?.(
            { name: message.name, id: message.tool_call_id },
            contentToString(message.content),
          );
          continue;
        }
        if (!AIMessage.isInstance(message)) continue;

        const messageUsage = message.usage_metadata;
        if (messageUsage) {
          usage.inputTokens += messageUsage.input_tokens ?? 0;
          usage.outputTokens += messageUsage.output_tokens ?? 0;
          usage.reasoningTokens += messageUsage.output_token_details?.reasoning ?? 0;
        }

        const reasoning = getReasoningContent(message);
        if (reasoning) cb.onReasoning?.(reasoning);

        const text = contentToString(message.content);
        if (text) {
          cb.onToken?.(text);
          answer += text;
        }

        if (!AIMessageChunk.isInstance(message) || !message.tool_call_chunks?.length) continue;
        const aggregated = toolCallChunks.get(streamKey)?.concat(message) ?? message;
        toolCallChunks.set(streamKey, aggregated);
        for (const toolCall of aggregated.tool_calls ?? []) {
          if (!toolCall.name || this.shouldInterrupt(toolCall.name)) continue;
          const key =
            toolCall.id || `${streamKey}:${toolCall.name}:${JSON.stringify(toolCall.args)}`;
          if (announcedToolCalls.has(key)) continue;
          announcedToolCalls.add(key);

          const call = { name: toolCall.name, args: toolCall.args, id: toolCall.id };
          const argsSummary = JSON.stringify(toolCall.args ?? {});
          cb.onToolCall?.(call);
          cb.onToolStart?.(call);
          if (!this.mcpToolNames.has(toolCall.name)) {
            cb.onAudit?.({
              source: "builtin",
              server: null,
              toolName: toolCall.name,
              decision: "auto",
              argsSummary,
            });
          }
        }
      }

      if (!hitl) break;

      const decisions: Array<{ type: "approve" } | { type: "reject"; message: string }> = [];
      for (const actionRequest of hitl.actionRequests) {
        const call = { name: actionRequest.name, args: actionRequest.args };
        const argsSummary = JSON.stringify(actionRequest.args ?? {});
        cb.onToolCall?.(call);
        const allowed = (await cb.requestPermission?.(actionRequest.name, argsSummary)) ?? true;
        if (allowed) {
          decisions.push({ type: "approve" });
          cb.onToolStart?.(call);
          cb.onAudit?.({
            source: "builtin",
            server: null,
            toolName: actionRequest.name,
            decision: "allowed",
            argsSummary,
          });
        } else {
          decisions.push({
            type: "reject",
            message: `用户拒绝了工具调用: ${actionRequest.name}`,
          });
          cb.onToolDenied?.(call);
          cb.onAudit?.({
            source: "builtin",
            server: null,
            toolName: actionRequest.name,
            decision: "denied",
            argsSummary,
          });
        }
      }
      nextInput = new Command({ resume: { decisions } });
    }

    // 把本轮产生的完整消息同步回 history（从 graph state 取最终序列，跳过 system + 输入 history）
    const state = await this.agent.graph.getState(config);
    const finalMessages = (state.values as { messages: BaseMessage[] }).messages ?? [];
    const added = finalMessages.slice(inputMessages.length);
    history.push(...added);

    if (process.env.DEBUG) dumpLlmIO(inputMessages, added);

    if (usage.inputTokens > 0 || usage.outputTokens > 0) {
      cb.onUsage?.(usage);
    }

    // 最终回复文本：取最后一个 AIMessage 的文本（answer 已含流式 token，作为兜底）
    for (let i = added.length - 1; i >= 0; i -= 1) {
      const msg = added[i];
      if (msg && AIMessage.isInstance(msg)) {
        const finalText = contentToString(msg.content);
        if (finalText) {
          answer = finalText;
          break;
        }
      }
    }
    return answer;
  }

  private shouldInterrupt(toolName: string): boolean {
    const config = this.interruptOn[toolName];
    return config === true || typeof config === "object";
  }
}

/**
 * 从 AIMessage(Chunk) 提取推理内容片段。
 * langchain-openai 会把 OpenAI 兼容 API 的 delta.reasoning_content 逐块放进
 * additional_kwargs.reasoning_content（非流式则为 message.reasoning_content）。
 */
function getReasoningContent(message: AIMessage): string | undefined {
  const raw = (message.additional_kwargs as { reasoning_content?: unknown }).reasoning_content;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/** agent.stream 在 streamMode 元组 + subgraphs 模式下的迭代元素类型。 */
type StreamTriple = [string[], string, unknown];
