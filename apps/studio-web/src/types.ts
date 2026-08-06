export type Role = "user" | "assistant" | "system" | "tool";

export type MessageStatus = "streaming" | "complete" | "error";

export type ToolCallStatus = "pending" | "done" | "error";

/**
 * 渲染用的 UI 块（由工具产生，例如财务报表卡片）。
 * 用可辨识联合便于后续扩展更多卡片类型。
 */
export type UiBlock =
  | {
      type: "financial_report_card";
      props: { reports: Array<{ id: string; name: string; status: string }> };
    }
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
  /** 助手消息：生成回复过程中发起的函数调用。 */
  toolCalls?: ToolCall[];
  /** 助手消息：需要内联渲染的 UI 块（卡片）。 */
  uiBlocks?: UiBlock[];
  /** 本次回答实际检索到的 RAG 片段。 */
  ragCitations?: RagCitation[];
  /** 兼容：来自服务端 DB 的历史 role:"tool" 行。 */
  tool_call_id?: string;
  tool_name?: string;
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
}

export function emptyChatResources(): ChatResourceBinding {
  return { mcpTools: [], rag: { sources: [], topK: 5 } };
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
