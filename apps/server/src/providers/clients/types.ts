import type { ProviderFormat } from "../formats.js";

/**
 * 面向 LLM 客户端的统一消息类型。
 * 各协议实现（OpenAI Chat / OpenAI Response / Anthropic Message）负责将其映射到自有格式。
 */
export type LlmMessageRole = "system" | "user" | "assistant" | "tool";

export interface LlmToolCallRequest {
  id: string;
  name: string;
  arguments: string;
}

export interface LlmMessage {
  role: LlmMessageRole;
  /** 消息内容。assistant 携带 tool_calls 时可为空字符串。 */
  content: string;
  /** assistant 消息声明的工具调用（供 tool 轮次回填）。 */
  tool_calls?: LlmToolCallRequest[];
  /** tool 消息关联的调用 id。 */
  tool_call_id?: string;
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmStreamCallbacks {
  /** 收到一段增量文本时触发。 */
  onDelta: (delta: string) => void;
}

export interface LlmStreamResult {
  content: string;
  toolCalls: Array<{ id?: string; name: string; arguments: string }>;
}

export interface LlmCompleteResult {
  content: string;
  tokenUsage?: { inputTokens: number; outputTokens: number };
}

/**
 * LLM 客户端统一抽象：按 Provider 的 format 选择实现。
 * - streamChat：多轮工具调用场景下的流式对话（chat 模块、workflow 未来可用）。
 * - complete：单次非流式补全（workflow LLM 节点当前使用）。
 */
export interface LlmClient {
  readonly format: ProviderFormat;
  streamChat(params: {
    model: string;
    messages: LlmMessage[];
    tools?: LlmToolDefinition[];
    signal?: AbortSignal;
    callbacks: LlmStreamCallbacks;
  }): Promise<LlmStreamResult>;
  complete(params: {
    model: string;
    messages: LlmMessage[];
    temperature?: number;
    signal?: AbortSignal;
  }): Promise<LlmCompleteResult>;
}
