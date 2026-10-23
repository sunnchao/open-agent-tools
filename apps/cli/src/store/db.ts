import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { SqliteSessionStore, sqliteTableColumns } from "@open-agent-tools/database/sqlite";
import type { CliMessage } from "./messages.ts";

export type Role = "user" | "assistant" | "system" | "tool" | "reasoning";
export type MessageStatus = "streaming" | "complete" | "error";

export interface Message {
  id: string;
  role: Role;
  content: string;
  createdAt: number;
  status?: MessageStatus;
  tool_call_id?: string;
  tool_name?: string;
}

/** 会话累计的模型 token 用量。 */
export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface Session {
  id: string;
  title: string;
  messages: Message[];
  updatedAt: number;
  usage?: SessionUsage;
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  usage?: SessionUsage;
}

const DEFAULT_DB_PATH = resolve(import.meta.dirname, "../../data/chat.sqlite");

let db: DatabaseSync | null = null;

export function getDbPath(): string {
  return process.env.SQLITE_PATH || DEFAULT_DB_PATH;
}

export function openDb(path = getDbPath()): DatabaseSync {
  if (db) return db;

  mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New chat',
      updated_at INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool', 'reasoning')),
      content TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      status TEXT,
      position INTEGER NOT NULL,
      tool_call_id TEXT,
      tool_name TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session_position
      ON messages(session_id, position);

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      session_id TEXT,
      source TEXT NOT NULL CHECK (source IN ('builtin', 'mcp')),
      server TEXT,
      tool_name TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('allowed', 'denied', 'auto')),
      args_summary TEXT,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);
  `);

  migrateMessagesTable(db);
  migrateSessionsTable(db);

  return db;
}

function migrateMessagesTable(database: DatabaseSync): void {
  const columns = sqliteTableColumns(database, "messages");

  if (!columns.has("tool_call_id")) {
    database.exec(`ALTER TABLE messages ADD COLUMN tool_call_id TEXT`);
  }
  if (!columns.has("tool_name")) {
    database.exec(`ALTER TABLE messages ADD COLUMN tool_name TEXT`);
  }

  // SQLite 无法 ALTER CHECK 约束：旧库的 role CHECK 不含 'reasoning'，
  // 需重建 messages 表以允许推理内容落库。
  const schema = database
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'`)
    .get() as { sql: string } | undefined;
  if (schema && !schema.sql.includes("'reasoning'")) {
    database.exec(`
      CREATE TABLE messages_new (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool', 'reasoning')),
        content TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        status TEXT,
        position INTEGER NOT NULL,
        tool_call_id TEXT,
        tool_name TEXT
      );
      INSERT INTO messages_new (id, session_id, role, content, created_at, status, position, tool_call_id, tool_name)
        SELECT id, session_id, role, content, created_at, status, position, tool_call_id, tool_name FROM messages;
      DROP TABLE messages;
      ALTER TABLE messages_new RENAME TO messages;
    `);
    database.exec(
      `CREATE INDEX IF NOT EXISTS idx_messages_session_position ON messages(session_id, position)`,
    );
  }

  database.exec(`DROP TABLE IF EXISTS messages_migration_backup`);
}

function migrateSessionsTable(database: DatabaseSync): void {
  const columns = new Set(
    (database.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  if (!columns.has("input_tokens")) {
    database.exec(`ALTER TABLE sessions ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0`);
  }
  if (!columns.has("output_tokens")) {
    database.exec(`ALTER TABLE sessions ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0`);
  }
  if (!columns.has("reasoning_tokens")) {
    database.exec(`ALTER TABLE sessions ADD COLUMN reasoning_tokens INTEGER NOT NULL DEFAULT 0`);
  }
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

function sessionStore(): SqliteSessionStore<Role, MessageStatus> {
  return new SqliteSessionStore<Role, MessageStatus>(openDb(), "complete");
}

function usageFromRow(row: {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}): SessionUsage {
  return {
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    reasoningTokens: row.reasoningTokens,
  };
}

export function listSessions(): SessionSummary[] {
  const database = openDb();
  const rows = database
    .prepare(
      `SELECT id, title, updated_at AS updatedAt,
              input_tokens AS inputTokens, output_tokens AS outputTokens,
              reasoning_tokens AS reasoningTokens
       FROM sessions
       ORDER BY updated_at DESC`,
    )
    .all() as Array<{
    id: string;
    title: string;
    updatedAt: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    updatedAt: row.updatedAt,
    usage: usageFromRow(row),
  }));
}

export function getSession(id: string): Session | null {
  const database = openDb();
  const session = database
    .prepare(
      `
    SELECT id, title, updated_at AS updatedAt, input_tokens AS inputTokens, output_tokens AS outputTokens, reasoning_tokens AS reasoningTokens
    FROM sessions WHERE id = ?
  `,
    )
    .get(id) as ({ id: string; title: string; updatedAt: number } & SessionUsage) | undefined;
  if (!session) return null;
  return {
    id: session.id,
    title: session.title,
    updatedAt: session.updatedAt,
    usage: usageFromRow(session),
    messages: sessionStore().messagesFor([id]).get(id)!,
  };
}

/** 累加会话的模型 token 用量（会话级累计，跨轮持续增长）。 */
export function addSessionUsage(sessionId: string, usage: SessionUsage): void {
  const database = openDb();
  database
    .prepare(
      `UPDATE sessions
       SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?,
           reasoning_tokens = reasoning_tokens + ?
       WHERE id = ?`,
    )
    .run(usage.inputTokens, usage.outputTokens, usage.reasoningTokens, sessionId);
}

export function createSession(input?: { id?: string; title?: string }): Session {
  const database = openDb();
  const id = input?.id ?? randomUUID();
  const title = input?.title ?? "New chat";
  const updatedAt = Date.now();

  database
    .prepare(`INSERT INTO sessions (id, title, updated_at) VALUES (?, ?, ?)`)
    .run(id, title, updatedAt);

  return {
    id,
    title,
    messages: [],
    updatedAt,
    usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
  };
}

export function renameSession(id: string, title: string): Session | null {
  return sessionStore().renameSession(id, title) ? getSession(id) : null;
}

export function deleteSession(id: string): boolean {
  return sessionStore().deleteSession(id);
}

export function touchSession(id: string, updatedAt = Date.now()): void {
  sessionStore().touchSession(id, updatedAt);
}

export function addMessage(
  sessionId: string,
  message: {
    id?: string;
    role: Role;
    content: string;
    createdAt?: number;
    status?: MessageStatus;
    tool_call_id?: string;
    tool_name?: string;
  },
): Message | null {
  return sessionStore().addMessage(sessionId, message);
}

export function updateMessage(
  messageId: string,
  patch: { content?: string; status?: MessageStatus },
): Message | null {
  return sessionStore().updateMessage(messageId, patch);
}

export function ensureSession(sessionId: string): Session {
  const existing = getSession(sessionId);
  if (existing) return existing;
  return createSession({ id: sessionId });
}

// ---- 审计日志：记录工具调用（来源、server、决策、参数摘要） ----

export type AuditSource = "builtin" | "mcp";
export type AuditDecision = "allowed" | "denied" | "auto";

export interface AuditEntry {
  ts?: number;
  sessionId?: string | null;
  source: AuditSource;
  server?: string | null;
  toolName: string;
  decision: AuditDecision;
  argsSummary?: string;
  error?: string | null;
}

export interface AuditRecord extends AuditEntry {
  id: string;
  ts: number;
}

export function logAudit(entry: AuditEntry): void {
  const database = openDb();
  const id = randomUUID();
  const ts = entry.ts ?? Date.now();
  database
    .prepare(
      `INSERT INTO audit_log (id, ts, session_id, source, server, tool_name, decision, args_summary, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      ts,
      entry.sessionId ?? null,
      entry.source,
      entry.server ?? null,
      entry.toolName,
      entry.decision,
      entry.argsSummary ?? null,
      entry.error ?? null,
    );
}

export function listAudit(limit = 50): AuditRecord[] {
  const database = openDb();
  const rows = database
    .prepare(
      `SELECT id, ts, session_id AS sessionId, source, server, tool_name AS toolName,
              decision, args_summary AS argsSummary, error
       FROM audit_log
       ORDER BY ts DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{
    id: string;
    ts: number;
    sessionId: string | null;
    source: AuditSource;
    server: string | null;
    toolName: string;
    decision: AuditDecision;
    argsSummary: string | null;
    error: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    sessionId: r.sessionId,
    source: r.source,
    server: r.server,
    toolName: r.toolName,
    decision: r.decision,
    argsSummary: r.argsSummary ?? undefined,
    error: r.error ?? undefined,
  }));
}

export function clearAudit(): void {
  openDb().exec(`DELETE FROM audit_log`);
}

export function messageToDbFormat(msg: CliMessage): {
  role: Role;
  content: string;
  tool_call_id?: string;
  tool_name?: string;
} {
  let role: Role;

  switch (msg.role) {
    case "user":
      role = "user";
      break;
    case "assistant":
      role = "assistant";
      break;
    case "system":
      role = "system";
      break;
    case "tool":
      role = "tool";
      break;
    default:
      role = "user";
  }

  const result: ReturnType<typeof messageToDbFormat> = { role, content: msg.content };

  if (msg.toolCallId) {
    result.tool_call_id = msg.toolCallId;
  }
  if (msg.toolName) {
    result.tool_name = msg.toolName;
  }

  return result;
}
