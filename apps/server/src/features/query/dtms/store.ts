/**
 * 问数会话存储（SQLite）。
 *
 * 与 chat 的 sessions/messages 分表，避免问数轮次混入聊天历史。
 * 写入失败只记 trace，绝不影响本轮回答。
 */
import { openDb } from "../../../platform/db.js";
import { logTrace, truncate } from "../../../platform/trace.js";

export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

let storeReady = false;

function ensureStore(): void {
  if (storeReady) return;
  openDb().exec(`
    CREATE TABLE IF NOT EXISTS ai_query_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      reply_type TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_query_messages_session
      ON ai_query_messages(session_id, created_at);
  `);
  storeReady = true;
}

export function persistTurn(
  sessionId: string,
  role: "user" | "assistant",
  content: string,
  replyType?: string,
): void {
  try {
    ensureStore();
    openDb()
      .prepare(
        `INSERT INTO ai_query_messages (id, session_id, role, content, reply_type, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `${sessionId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        sessionId,
        role,
        content,
        replyType ?? null,
        Date.now(),
      );
  } catch (error) {
    logTrace(
      "ai_query.persist",
      { sessionId, error: truncate(error instanceof Error ? error.message : String(error), 200) },
      "warn",
    );
  }
}

export function loadHistory(sessionId: string, limit: number): HistoryTurn[] {
  try {
    ensureStore();
    const rows = openDb()
      .prepare(
        `SELECT role, content FROM ai_query_messages
         WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(sessionId, limit) as Array<{ role: "user" | "assistant"; content: string }>;
    return rows.reverse();
  } catch {
    return [];
  }
}
