import type { QueryStep } from "./features/observatory/api.js";

export type Role = "user" | "assistant" | "system" | "tool";

export type MessageStatus = "streaming" | "complete" | "error" | "stopped";

export type ToolCallStatus = "pending" | "done" | "error";

export interface SqlResultProps {
  usage?: MessageUsage;
  rows: Record<string, unknown>[];
  sourceId?: string;
  sourceName?: string;
  question?: string;
  sql?: string;
  auditId?: string;
  steps?: QueryStep[];
  durationMs?: number;
  truncated?: boolean;
  clarifying?: string;
}

/**
 * 渲染用的 UI 块（由工具产生，例如财务报表卡片）。
 * 用可辨识联合便于后续扩展更多卡片类型。
 */
export type UiBlock =
  | {
      type: "financial_report_card";
      props: { reports: Array<{ id: string; name: string; status: string }> };
    }
  | { type: "sql_result"; props: SqlResultProps }
  // 兼容服务端可能下发的其它 ui 形状。
  | { type: string; [key: string]: unknown };

/**
 * 一次函数调用（function calling）的完整记录：
 * - 请求侧：name + arguments（原始 JSON 字符串）
 * - 响应侧：result / ui / error 与生命周期状态
 * 这是对话记录中“function calling”的第一公民表示，会随会话一起被缓存。
 */
export interface ToolCall {
  /** 模型分配的工具调用 id（部分 provider 可能缺失）。 */
  id?: string;
  /** 工具 / 函数名。 */
  name: string;
  /** 原始的 JSON 参数（字符串）。 */
  arguments: string;
  /** 执行结果（结构化）。 */
  result?: unknown;
  /** 工具产出的 UI 块（如卡片）。 */
  ui?: UiBlock;
  /** 执行错误信息。 */
  error?: string;
  /** 生命周期状态。 */
  status?: ToolCallStatus;
}

export interface Message {
  id: string;
  role: Role;
  content: string;
  createdAt: number;
  status?: MessageStatus;
  /** 生成失败时的错误文案。与 content 分开，避免刷新后把 partial 覆盖掉。 */
  errorMessage?: string;
  /** 助手消息：生成回复过程中发起的函数调用。 */
  toolCalls?: ToolCall[];
  /** 助手消息：需要内联渲染的 UI 块（卡片）。 */
  uiBlocks?: UiBlock[];
  /** 本次回答实际检索到的 RAG 片段。 */
  ragCitations?: RagCitation[];
  /** 本轮 token 与工具调用用量（服务端计量口径，用于成本展示与对账）。 */
  usage?: MessageUsage;
  /** 兼容：来自服务端 DB 的历史 role:"tool" 行。 */
  tool_call_id?: string;
  tool_name?: string;
}

/** 与服务端 SSE `usage` 事件、`/api/admin/usage` 汇总保持同一口径。 */
export interface MessageUsage {
  /** Older saved messages may not contain the request count. */
  requests?: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  toolCalls: number;
  toolErrors: number;
}

export interface RagCitation {
  source: string;
  chunkIndex: number;
  content: string;
  [key: string]: unknown;
}

export interface McpToolBinding {
  serviceSlug: string;
  toolName: string;
}

export interface ChatResourceBinding {
  mcpTools: McpToolBinding[];
  rag: {
    sources: string[];
    topK: number;
  };
  /** 绑定的 SQL 问数数据源，服务端校验存在且启用。 */
  sqlSources: string[];
}

export function emptyChatResources(): ChatResourceBinding {
  return { mcpTools: [], rag: { sources: [], topK: 5 }, sqlSources: [] };
}

export interface Session {
  id: string;
  title: string;
  messages: Message[];
  updatedAt: number;
  resources: ChatResourceBinding;
  /** 会话级模型路由：选中的 Provider id（缺省走服务端 default）。 */
  providerId?: string;
  /** 会话级模型名；缺省时服务端回退到 Provider 的第一个模型。 */
  model?: string;
}

/** 发送给服务端的消息形态——剥离仅前端使用的字段。 */
export interface ChatRequestMessage {
  role: Role;
  content: string;
}
