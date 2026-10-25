/**
 * 请求级上下文预算强制（P0：零模型调用）。
 *
 * 无状态 HTTP，不做“压缩事件/状态机”：每次组装 LLM 输入时按预算裁剪，
 * 原文在 DB 全量保留。滚动摘要（P1）另行写入 `im_memory_summaries`，
 * 由历史回读拼回，本模块只负责“送什么给模型”。
 *
 * Token 估算口径与前端共享（`@open-agent-tools/studio-client`），
 * 同一实现、同一系数，避免两端 meter 对不上。
 */
import {
  type ChatCompactReport,
  estimateMessageTokens,
  estimateTokens,
} from "@open-agent-tools/studio-client";

export { estimateMessageTokens, estimateTokens };

export interface CompactionBudget {
  /** 单轮输入硬上限（估算 tokens）。 */
  inputCap: number;
  /** 给输出与工具回填的预留说明位（当前仅记账，实际扣减在 provider 窗口侧）。 */
  reserveOutput: number;
  /** 无论如何保留的最近 user 轮数。 */
  keepRecentTurns: number;
  /** RAG 注入文本上限（字符）。 */
  ragMaxChars: number;
  /** 单个工具结果回填上限（字符，DB 落库不受影响）。 */
  toolResultMaxChars: number;
}

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveCompactionBudget(): CompactionBudget {
  return {
    inputCap: envPositiveInt("CHAT_INPUT_CAP", 24_000),
    reserveOutput: envPositiveInt("CHAT_RESERVE_OUTPUT", 4_000),
    keepRecentTurns: envPositiveInt("CHAT_KEEP_RECENT_TURNS", 20),
    ragMaxChars: envPositiveInt("CHAT_RAG_MAX_CHARS", 8_000),
    toolResultMaxChars: envPositiveInt("CHAT_TOOL_RESULT_MAX_CHARS", 6_000),
  };
}

/** 按字符上限截断，超限时追加显式标记（调用方决定落库用原文还是截断版）。 */
export function capText(
  text: string,
  maxChars: number,
  marker: string,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, Math.max(0, maxChars))}${marker}`, truncated: true };
}

export interface CompactConversationOptions {
  /** 工具定义等固定开销（估算 tokens），从可用预算中预扣。 */
  reservedTokens?: number;
}

export interface CompactConversationResult<T> {
  messages: T[];
  estimatedTokens: number;
  /** system 消息（含 RAG 注入）的估算 tokens，用于构成拆分。 */
  systemTokens: number;
  droppedMessages: number;
  keptUserTurns: number;
}

/**
 * 保 system、保最近 N user 轮、从旧往新裁。
 * 一轮 = 一条 user 消息及其后跟随的非 user 消息；泛型透传不改动消息其他字段
 *（如 assistant 的 tool_calls）。
 */
export function compactConversation<T extends { role: string; content: string }>(
  messages: T[],
  budget: CompactionBudget,
  options: CompactConversationOptions = {},
): CompactConversationResult<T> {
  const reserved = options.reservedTokens ?? 0;
  const system = messages.filter((message) => message.role === "system");
  const rest = messages.filter((message) => message.role !== "system");

  let systemTokens = reserved;
  for (const message of system) {
    systemTokens += estimateMessageTokens(message.role, message.content);
  }

  // 按 user 消息切轮；开头的非 user 消息自成一轮（不丢弃，只参与排序）。
  const turns: T[][] = [];
  for (const message of rest) {
    if (message.role === "user" || turns.length === 0) turns.push([]);
    turns[turns.length - 1]!.push(message);
  }

  const kept: T[][] = [];
  let historyTokens = 0;
  let keptUserTurns = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    let turnTokens = 0;
    for (const message of turn) {
      turnTokens += estimateMessageTokens(message.role, message.content);
    }
    const isUserTurn = turn[0]!.role === "user";
    if (
      kept.length > 0 &&
      systemTokens + historyTokens + turnTokens > budget.inputCap &&
      keptUserTurns >= budget.keepRecentTurns
    ) {
      break;
    }
    kept.unshift(turn);
    historyTokens += turnTokens;
    if (isUserTurn) keptUserTurns += 1;
  }

  return {
    messages: [...system, ...kept.flat()],
    estimatedTokens: systemTokens + historyTokens,
    systemTokens,
    droppedMessages: rest.length - kept.flat().length,
    keptUserTurns,
  };
}
/**
 * 组装 SSE `compact` 帧 / `done` 回显的快照。
 * ragTokens 由调用方在注入点实测（注入后的首条 system 消息），
 * 其余 system 归为 system 段，保证 history + rag + tools + system == estimatedTokens。
 */
export function buildCompactReport(input: {
  compacted: Pick<CompactConversationResult<unknown>, "estimatedTokens" | "systemTokens" | "droppedMessages" | "keptUserTurns">;
  budget: CompactionBudget;
  toolsTokens: number;
  ragTokens: number;
  ragTruncated: boolean;
}): ChatCompactReport {
  const system = Math.max(0, input.compacted.systemTokens - input.toolsTokens - input.ragTokens);
  const history = Math.max(0, input.compacted.estimatedTokens - input.compacted.systemTokens);
  return {
    estimatedTokens: input.compacted.estimatedTokens,
    inputCap: input.budget.inputCap,
    droppedMessages: input.compacted.droppedMessages,
    keptUserTurns: input.compacted.keptUserTurns,
    toolsTokens: input.toolsTokens,
    ragTruncated: input.ragTruncated,
    breakdown: { history, rag: input.ragTokens, tools: input.toolsTokens, system },
  };
}
