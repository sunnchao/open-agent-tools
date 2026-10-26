/**
 * 会话历史回读：把 DB 里已有的多轮对话装回请求。
 *
 * 为什么不信任客户端传来的 messages：
 * - IM 只发当前一句话（`im/chatClient.ts` 的请求体），服务端必须自己补历史；
 * - Web 每轮全量重发，长会话会撑爆窗口，且可能夹带已删除的消息。
 *
 * 因此统一以 DB 为准：窗口 + 摘要，客户端消息只用来定位“本轮问题”。
 */
import { openDb } from "../db.js";
import { getSummary } from "../memory/store.js";

export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

export interface LoadHistoryOptions {
  /** 保留最近多少轮问答（一轮 = user + 其后的 assistant）。 */
  turns?: number;
  /** 字符预算上限（与 compaction 的估算口径互补，这里是硬字符闸）。 */
  maxChars?: number;
}

export interface LoadedHistory {
  turns: HistoryTurn[];
  /** 被窗口裁掉的更早轮数。 */
  omittedTurns: number;
  /** 会话摘要（若有），由调用方决定是否注入。 */
  summary: string | null;
}

/**
 * 读取最近 N 轮已完成的问答。
 *
 * - 只取 status 为 complete / 空（历史数据）的 user/assistant 行；
 * - `tool` 行不返回（历史里缺少 assistant.tool_calls 结构，拼回去会被
 *   OpenAI 拒绝，`chatCore` 本来也会丢弃它们）；
 * - 与 `excludeMessageIds` 去重，避免把本轮刚落的用户消息重复拼进去。
 */
export function loadSessionHistory(
  sessionId: string,
  options: LoadHistoryOptions & { excludeMessageIds?: Iterable<string> } = {},
): LoadedHistory {
  const database = openDb();
  const excluded = new Set(options.excludeMessageIds ?? []);
  const rows = database
    .prepare(
      `SELECT id, role, content, status
       FROM messages
       WHERE session_id = ? AND role IN ('user', 'assistant')
       ORDER BY position ASC`,
    )
    .all(sessionId) as Array<{ id: string; role: "user" | "assistant"; content: string; status: string | null }>;

  const usable = rows.filter(
    (row) =>
      !excluded.has(row.id) &&
      row.content.trim().length > 0 &&
      (row.status === null || row.status === "complete"),
  );

  const turns: HistoryTurn[] = [];
  const turnGroups: HistoryTurn[][] = [];
  for (const row of usable) {
    if (row.role === "user" || turnGroups.length === 0) turnGroups.push([]);
    turnGroups[turnGroups.length - 1]!.push({ role: row.role, content: row.content });
  }

  const limit = options.turns ?? 20;
  const maxChars = options.maxChars ?? 12_000;
  let used = 0;
  let keptGroups = 0;
  for (let index = turnGroups.length - 1; index >= 0; index -= 1) {
    const group = turnGroups[index]!;
    const chars = group.reduce((sum, item) => sum + item.content.length, 0);
    if (keptGroups >= limit) break;
    if (used + chars > maxChars && keptGroups > 0) break;
    used += chars;
    keptGroups += 1;
    turns.unshift(...group);
  }

  return {
    turns,
    omittedTurns: turnGroups.length - keptGroups,
    summary: getSummary(sessionId)?.summary ?? null,
  };
}
