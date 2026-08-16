/**
 * CLI 自建消息模型（替代 LangChain BaseMessage，P1.4 依赖清理）。
 * 贯通 repl / commands / store(db) / piRuntime 的消息表示。
 */

export type CliMessageRole = "user" | "assistant" | "system" | "tool";

export interface CliMessage {
  role: CliMessageRole;
  content: string;
  /** tool 消息关联的调用 id。 */
  toolCallId?: string;
  /** tool 消息的工具名（展示用）。 */
  toolName?: string;
}

/** 工具调用展示/回调形状（原 deepagent 的 ToolCallLike）。 */
export interface ToolCallLike {
  name?: string;
  args?: unknown;
  id?: string;
}
