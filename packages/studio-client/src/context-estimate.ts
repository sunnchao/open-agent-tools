/**
 * 上下文用量估算（前后端共享口径）。
 *
 * 服务端 `apps/server/src/compaction.ts` 与 Web 前端都从这里 import，
 * 同一实现、同一系数，避免两端 meter 对不上。估算仅供展示与预算，
 * 不得用于计费（计费以模型实际用量为准）。
 */

/** 估算与实际用量的换算保守系数（宁多勿少，避免预算击穿）。 */
export const TOKEN_ESTIMATE_MARGIN = 1.2;

/** 单条消息在不同 role 间的传输开销（OpenAI 按 ~3-4 tokens/条计）。 */
export const OVERHEAD_TOKENS_PER_MESSAGE = 4;

/**
 * 零依赖 token 估算：英文 ~4 chars/token，中文 ~1.5 chars/token，
 * 整体乘保守系数。长期用 Langfuse 的估算/实际用量对账校准。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) <= 0x7f) ascii += 1;
  }
  const nonAscii = text.length - ascii;
  return Math.ceil((ascii / 4 + nonAscii / 1.5) * TOKEN_ESTIMATE_MARGIN);
}

export function estimateMessageTokens(role: string, content: string): number {
  return OVERHEAD_TOKENS_PER_MESSAGE + estimateTokens(role) + estimateTokens(content);
}

/** 紧凑显示：12,400 → "12.4k"，小数字保持原样。 */
export function formatKiloTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1000) return String(Math.round(value));
  const truncated = Math.floor(value / 100) / 10;
  return `${truncated % 1 === 0 ? truncated.toFixed(0) : truncated.toFixed(1)}k`;
}

/** SSE `compact` 帧 / `done` 回显的上下文快照（前后端契约）。 */
export interface ChatCompactReport {
  /** 本轮实际送往模型的估算输入 tokens。 */
  estimatedTokens: number;
  /** 服务端输入预算（CHAT_INPUT_CAP）。 */
  inputCap: number;
  /** 被裁掉的历史消息条数。 */
  droppedMessages: number;
  /** 保留的 user 轮数。 */
  keptUserTurns: number;
  /** 工具定义占用的估算 tokens。 */
  toolsTokens: number;
  /** RAG 注入文本是否被截断。 */
  ragTruncated: boolean;
  /** 四段构成（估算 tokens）：历史 / RAG / 工具定义 / 其他系统提示。 */
  breakdown: { history: number; rag: number; tools: number; system: number };
}
