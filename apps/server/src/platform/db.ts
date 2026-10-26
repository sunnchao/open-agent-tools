import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { SqliteSessionStore } from "@open-agent-tools/database/sqlite";
import { logDebugDuration } from "./trace.js";
import { applySchema } from "./schema/registry.js";

export type Role = "user" | "assistant" | "system" | "tool";
export type MessageStatus = "streaming" | "complete" | "error" | "stopped";

/**
 * 默认 workspace：历史数据与未显式指定归属的资源都落在它下面。
 * 用固定字符串而非随机 UUID，便于迁移与排障时人工辨认。
 */
export const DEFAULT_WORKSPACE_ID = "default";

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

const DEFAULT_DB_PATH = resolve(import.meta.dirname, "../../data/chat.sqlite");

let db: DatabaseSync | null = null;

export function getDbPath(): string {
  return process.env.SQLITE_PATH || DEFAULT_DB_PATH;
}

export function openDb(path = getDbPath()): DatabaseSync {
  if (db) return db;
  const startedAt = Date.now();

  mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");

  // 表定义与补列顺序由 `platform/schema/registry.ts` 统一持有：
  // 每个域自带 DDL 与迁移，这里只负责执行一次。
  applySchema(db);

  logDebugDuration("db.open", startedAt, { path });
  return db;
}

/** 为存量库补齐 workspace 归属列：新建库由 CREATE TABLE 直接带上，老库走 ALTER。 */

/** 发布应用新增的访问控制与配额列：老库走 ALTER，默认值保证行为向后兼容。 */

/** 默认 workspace 必须存在，否则新会话与老数据的归属会落空。 */

/** Add tool_call_id / tool_name on legacy DBs without destructive rebuild. */

/** Add format column on legacy DBs (defaults to OpenAI Chat). */

/** Test helper: close and forget the singleton. */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

function sessionStore(): SqliteSessionStore<Role, MessageStatus> {
  return new SqliteSessionStore<Role, MessageStatus>(openDb(), "complete");
}

/**
 * 会话来源。
 * - 'web'：Web / App 聊天；
 * - 'im'：IM 机器人（飞书/钉钉）问答。
 * IM 会话统一标 'im'，平台维度靠 actor / channel_id 表达，便于筛选与统计。
 */
export type SessionSource = "web" | "im";

/**
 * 会话来源筛选。
 * - 'web'（默认）：Web / App 聊天会话；
 * - 'im'：IM 机器人会话；
 * - 'all'：不限来源。
 */
export type SessionSourceFilter = SessionSource | "all";

export interface SessionListOptions {
  /** 缺省只看 Web 会话，避免 IM 会话污染 Web 侧边栏。 */
  source?: SessionSourceFilter;
}

export function listSessions(
  workspaceId?: string,
  options: SessionListOptions = {},
): SessionSummary[] {
  const database = openDb();
  const source = options.source ?? "web";
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (workspaceId) {
    conditions.push("workspace_id = ?");
    params.push(workspaceId);
  }
  if (source !== "all") {
    conditions.push("source = ?");
    params.push(source);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const scoped = database
    .prepare(
      `SELECT id, title, updated_at AS updatedAt
       FROM sessions
       ${where}
       ORDER BY updated_at DESC`,
    )
    .all(...params);
  return scoped as Array<{ id: string; title: string; updatedAt: number }>;
}

export function getSession(id: string): Session | null {
  const database = openDb();
  const session = database
    .prepare(
      `
    SELECT id, title, updated_at AS updatedAt
    FROM sessions WHERE id = ?
  `,
    )
    .get(id) as { id: string; title: string; updatedAt: number } | undefined;
  if (!session) return null;
  return {
    id: session.id,
    title: session.title,
    updatedAt: session.updatedAt,
    messages: sessionStore().messagesFor([id]).get(id)!,
  };
}

/** 读取会话的 workspace 归属（计量归集用）；会话不存在时返回 null。 */
export function getSessionWorkspaceId(id: string): string | null {
  const row = openDb()
    .prepare(`SELECT workspace_id AS workspaceId FROM sessions WHERE id = ?`)
    .get(id) as { workspaceId: string | null } | undefined;
  return row?.workspaceId ?? null;
}

export function listSessionsWithMessages(
  workspaceId?: string,
  options: SessionListOptions = {},
): Session[] {
  const startedAt = Date.now();
  const summaries = listSessions(workspaceId, options);
  const messages = sessionStore().messagesFor(summaries.map((session) => session.id));
  const sessions = summaries.map((session) => ({
    ...session,
    messages: messages.get(session.id)!,
  }));
  logDebugDuration("db.list_sessions_with_messages", startedAt, { sessions: sessions.length });
  return sessions;
}

export interface SessionCreateOptions {
  id?: string;
  title?: string;
  workspaceId?: string;
  /** 来源：'web'（默认）或 'im'。 */
  source?: SessionSource;
  /** IM 来源的平台用户 id。 */
  actor?: string | null;
  /** IM 来源的渠道 id。 */
  channelId?: string | null;
}

export function createSession(input?: SessionCreateOptions): Session {
  const database = openDb();
  const id = input?.id ?? randomUUID();
  const title = input?.title ?? "New chat";
  const workspaceId = input?.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const source = input?.source ?? "web";
  const updatedAt = Date.now();

  database
    .prepare(
      `INSERT INTO sessions (id, title, updated_at, workspace_id, source, actor, channel_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, title, updatedAt, workspaceId, source, input?.actor ?? null, input?.channelId ?? null);

  return { id, title, messages: [], updatedAt };
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
  return sessionStore().addMessage(sessionId, message, { returnExisting: true });
}

export function updateMessage(
  messageId: string,
  patch: { content?: string; status?: MessageStatus },
): Message | null {
  return sessionStore().updateMessage(messageId, patch);
}

export function deleteMessage(messageId: string): boolean {
  return sessionStore().deleteMessage(messageId);
}

export function ensureSession(
  sessionId: string,
  workspaceId?: string,
  options: SessionCreateOptions = {},
): Session {
  const existing = getSession(sessionId);
  if (existing) return existing;
  return createSession({ id: sessionId, ...(workspaceId ? { workspaceId } : {}), ...options });
}
