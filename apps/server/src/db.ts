import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export type Role = "user" | "assistant" | "system" | "tool";
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

export interface Session {
  id: string;
  title: string;
  messages: Message[];
  updatedAt: number;
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
}

const DEFAULT_DB_PATH = resolve(import.meta.dirname, "../data/chat.sqlite");

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
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
      content TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      status TEXT,
      position INTEGER NOT NULL,
      tool_call_id TEXT,
      tool_name TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session_position
      ON messages(session_id, position);

    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key_enc TEXT,
      models_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  migrateMessagesTable(db);

  return db;
}

function messageColumns(database: DatabaseSync): Set<string> {
  const rows = database.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

/** Add tool_call_id / tool_name on legacy DBs without destructive rebuild. */
function migrateMessagesTable(database: DatabaseSync): void {
  const columns = messageColumns(database);

  if (!columns.has("tool_call_id")) {
    database.exec(`ALTER TABLE messages ADD COLUMN tool_call_id TEXT`);
  }
  if (!columns.has("tool_name")) {
    database.exec(`ALTER TABLE messages ADD COLUMN tool_name TEXT`);
  }

  // Drop leftover backup from a previous failed rebuild migration.
  database.exec(`DROP TABLE IF EXISTS messages_migration_backup`);
}

/** Test helper: close and forget the singleton. */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

function autoTitle(content: string): string {
  const trimmed = content.trim().replace(/\n/g, " ");
  return trimmed.length > 32 ? `${trimmed.slice(0, 32)}…` : trimmed || "New chat";
}

export function listSessions(): SessionSummary[] {
  const database = openDb();
  const rows = database
    .prepare(
      `SELECT id, title, updated_at AS updatedAt
       FROM sessions
       ORDER BY updated_at DESC`,
    )
    .all() as Array<{ id: string; title: string; updatedAt: number }>;
  return rows;
}

export function getSession(id: string): Session | null {
  const database = openDb();
  const session = database
    .prepare(
      `SELECT id, title, updated_at AS updatedAt
       FROM sessions
       WHERE id = ?`,
    )
    .get(id) as { id: string; title: string; updatedAt: number } | undefined;

  if (!session) return null;

  const messages = database
    .prepare(
      `SELECT id, role, content, created_at AS createdAt, status,
              tool_call_id AS toolCallId, tool_name AS toolName
       FROM messages
       WHERE session_id = ?
       ORDER BY position ASC`,
    )
    .all(id) as Array<{
    id: string;
    role: Role;
    content: string;
    createdAt: number;
    status: MessageStatus | null;
    toolCallId: string | null;
    toolName: string | null;
  }>;

  return {
    id: session.id,
    title: session.title,
    updatedAt: session.updatedAt,
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
      ...(m.status ? { status: m.status } : {}),
      ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
      ...(m.toolName ? { tool_name: m.toolName } : {}),
    })),
  };
}

export function listSessionsWithMessages(): Session[] {
  return listSessions()
    .map((s) => getSession(s.id))
    .filter((s): s is Session => s !== null);
}

export function createSession(input?: { id?: string; title?: string }): Session {
  const database = openDb();
  const id = input?.id ?? randomUUID();
  const title = input?.title ?? "New chat";
  const updatedAt = Date.now();

  database
    .prepare(`INSERT INTO sessions (id, title, updated_at) VALUES (?, ?, ?)`)
    .run(id, title, updatedAt);

  return { id, title, messages: [], updatedAt };
}

export function renameSession(id: string, title: string): Session | null {
  const database = openDb();
  const updatedAt = Date.now();
  const result = database
    .prepare(`UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`)
    .run(title, updatedAt, id);

  if (result.changes === 0) return null;
  return getSession(id);
}

export function deleteSession(id: string): boolean {
  const database = openDb();
  const result = database.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  return result.changes > 0;
}

export function touchSession(id: string, updatedAt = Date.now()): void {
  openDb().prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(updatedAt, id);
}

function nextPosition(sessionId: string): number {
  const row = openDb()
    .prepare(`SELECT COALESCE(MAX(position), -1) AS maxPos FROM messages WHERE session_id = ?`)
    .get(sessionId) as { maxPos: number };
  return row.maxPos + 1;
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
  const database = openDb();
  const session = database.prepare(`SELECT id, title FROM sessions WHERE id = ?`).get(sessionId) as
    { id: string; title: string } | undefined;
  if (!session) return null;

  const id = message.id ?? randomUUID();
  const createdAt = message.createdAt ?? Date.now();
  const status = message.status ?? "complete";
  const position = nextPosition(sessionId);

  database
    .prepare(
      `INSERT INTO messages (id, session_id, role, content, created_at, status, position, tool_call_id, tool_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      sessionId,
      message.role,
      message.content,
      createdAt,
      status,
      position,
      message.tool_call_id ?? null,
      message.tool_name ?? null,
    );

  if (session.title === "New chat" && message.role === "user") {
    const title = autoTitle(message.content);
    database
      .prepare(`UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`)
      .run(title, createdAt, sessionId);
  } else {
    touchSession(sessionId, createdAt);
  }

  return {
    id,
    role: message.role,
    content: message.content,
    createdAt,
    status,
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.tool_name ? { tool_name: message.tool_name } : {}),
  };
}

export function updateMessage(
  messageId: string,
  patch: { content?: string; status?: MessageStatus },
): Message | null {
  const database = openDb();
  const existing = database
    .prepare(
      `SELECT id, session_id AS sessionId, role, content, created_at AS createdAt, status
       FROM messages WHERE id = ?`,
    )
    .get(messageId) as
    | {
        id: string;
        sessionId: string;
        role: Role;
        content: string;
        createdAt: number;
        status: MessageStatus | null;
      }
    | undefined;

  if (!existing) return null;

  const content = patch.content ?? existing.content;
  const status = patch.status ?? existing.status ?? "complete";

  database
    .prepare(`UPDATE messages SET content = ?, status = ? WHERE id = ?`)
    .run(content, status, messageId);

  touchSession(existing.sessionId);

  return {
    id: existing.id,
    role: existing.role,
    content,
    createdAt: existing.createdAt,
    status,
  };
}

export function deleteMessage(messageId: string): boolean {
  const database = openDb();
  const existing = database
    .prepare(`SELECT session_id AS sessionId FROM messages WHERE id = ?`)
    .get(messageId) as { sessionId: string } | undefined;

  if (!existing) return false;

  database.prepare(`DELETE FROM messages WHERE id = ?`).run(messageId);
  touchSession(existing.sessionId);
  return true;
}

export function ensureSession(sessionId: string): Session {
  const existing = getSession(sessionId);
  if (existing) return existing;
  return createSession({ id: sessionId });
}
