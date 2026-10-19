/**
 * C7 多轮追问:把「问数」结果串成上下文,让「那 3 月呢」「换成渠道维度」这类
 * 指代型追问能接着上一轮继续,而不是每次从零开始。
 */

export interface SqlTurn {
  role: "user" | "assistant";
  content: string;
}

/** 与服务端 history 截断口径对齐,避免 prompt 随轮次无限增长。 */
export const MAX_FOLLOW_UP_TURNS = 8;

/** 追加一轮问答并保留最近若干条;空内容直接忽略。 */
export function appendTurn(history: SqlTurn[], user: string, assistant: string): SqlTurn[] {
  const trimmedUser = user.trim();
  const trimmedAssistant = assistant.trim();
  if (!trimmedUser || !trimmedAssistant) return history.slice(-MAX_FOLLOW_UP_TURNS);
  const next: SqlTurn[] = [
    ...history,
    { role: "user", content: trimmedUser },
    { role: "assistant", content: trimmedAssistant },
  ];
  return next.slice(-MAX_FOLLOW_UP_TURNS);
}

/**
 * 从查询结果里挑出对下一轮最有价值的助手侧文本。
 * 优先带回生成的 SQL(追问通常是在既有 SQL 上改口径),其次是澄清问题与错误。
 */
export function assistantSummary(result: {
  clarifying?: string;
  generatedSql?: string;
  sql?: string;
  executedSql?: string;
  error?: string;
}): string {
  if (result.clarifying) return result.clarifying;
  const sql = result.generatedSql || result.sql || result.executedSql;
  if (sql) return `生成的 SQL:\n${sql}`;
  if (result.error) return `查询失败:${result.error}`;
  return "";
}

/** 该轮是否带着上一轮的上下文(用于展示「追问」提示与计数)。 */
export function carriedUserTurns(history: SqlTurn[]): number {
  return history.filter((turn) => turn.role === "user").length;
}
