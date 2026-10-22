/**
 * IM 会话审计。
 *
 * 每次 IM 问答（成功或失败）落一条审计，供「统一审计中心」按
 * 工作区 / 平台 / 渠道 / 用户 / 群私聊维度回溯「谁问了什么、答了什么」。
 *
 * 写入方在 bot 层调用；**写审计失败绝不能影响回复**，因此
 * `recordImChatAudit` 内部吞掉异常（返回 null），调用方只需 try/catch 包一层即可。
 */

import { randomUUID } from "node:crypto";
import { openDb } from "../db.js";
import { DEFAULT_WORKSPACE_ID } from "../workspace.js";
import type { ImPlatform } from "./types.js";

export type ImChatAuditStatus = "ok" | "error";

export type ImChatType = "p2p" | "group";

/** question / answer 的最大落库长度（超出截断并追加省略号标记）。 */
export const IM_AUDIT_TEXT_LIMIT = 2000;

export interface ImChatAuditInput {
  channelId?: string | null;
  channelName?: string | null;
  platform: ImPlatform;
  sessionId?: string | null;
  workspace?: string | null;
  /** 平台用户 id（钉钉 senderStaffId / 飞书 senderOpenId）。 */
  actor?: string | null;
  /** 平台提供的昵称；平台没给就留空，不臆造。 */
  actorName?: string | null;
  chatType?: ImChatType;
  conversationId?: string | null;
  question?: string | null;
  answer?: string | null;
  status?: ImChatAuditStatus;
  error?: string | null;
  durationMs?: number;
  /** 本轮工具调用次数。 */
  toolCalls?: number;
  /** 本轮引用的知识片段数。 */
  citations?: number;
  createdAt?: number;
}

export interface ImChatAudit {
  id: string;
  channelId: string | null;
  channelName: string | null;
  platform: string;
  sessionId: string | null;
  workspace: string;
  actor: string | null;
  actorName: string | null;
  chatType: string;
  conversationId: string | null;
  question: string;
  answer: string;
  status: ImChatAuditStatus;
  error: string | null;
  durationMs: number;
  toolCalls: number;
  citations: number;
  createdAt: number;
}

export interface ImChatAuditFilters {
  workspace?: string;
  platform?: string;
  channelId?: string;
  actor?: string;
  chatType?: string;
  status?: string;
  /** 毫秒时间戳（含）。 */
  from?: number;
  /** 毫秒时间戳（含）。 */
  to?: number;
  /** 问题/回答模糊匹配。 */
  keyword?: string;
  limit?: number;
  offset?: number;
}

interface ImChatAuditRow {
  id: string;
  channel_id: string | null;
  channel_name: string | null;
  platform: string;
  session_id: string | null;
  workspace: string;
  actor: string | null;
  actor_name: string | null;
  chat_type: string;
  conversation_id: string | null;
  question: string;
  answer: string;
  status: string;
  error: string | null;
  duration_ms: number;
  tool_calls: number;
  citations: number;
  created_at: number;
}

function database() {
  const db = openDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS im_chat_audits (
      id TEXT PRIMARY KEY,
      channel_id TEXT,
      channel_name TEXT,
      platform TEXT NOT NULL,
      session_id TEXT,
      workspace TEXT NOT NULL DEFAULT '${DEFAULT_WORKSPACE_ID}',
      actor TEXT,
      actor_name TEXT,
      chat_type TEXT NOT NULL DEFAULT 'p2p',
      conversation_id TEXT,
      question TEXT NOT NULL DEFAULT '',
      answer TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'ok',
      error TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      citations INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `);
  migrateImChatAuditColumns(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_im_chat_audits_workspace_created
      ON im_chat_audits(workspace, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_im_chat_audits_platform_created
      ON im_chat_audits(platform, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_im_chat_audits_channel_created
      ON im_chat_audits(channel_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_im_chat_audits_actor_created
      ON im_chat_audits(actor, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_im_chat_audits_actor_name_created
      ON im_chat_audits(actor_name, created_at DESC);
  `);
  return db;
}

/** 存量库补列（幂等）；新建库由 CREATE TABLE 直接带上。 */
function migrateImChatAuditColumns(db: ReturnType<typeof openDb>): void {
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(im_chat_audits)`).all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  const additions = [
    ["channel_name", "TEXT"],
    ["actor_name", "TEXT"],
    ["tool_calls", "INTEGER NOT NULL DEFAULT 0"],
    ["citations", "INTEGER NOT NULL DEFAULT 0"],
  ] as const;
  for (const [name, definition] of additions) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE im_chat_audits ADD COLUMN ${name} ${definition}`);
    }
  }
}

/** 截断长文本（question/answer 各 2000 字符），避免审计表被长文本撑爆。 */
export function truncateAuditText(
  value: string | null | undefined,
  limit = IM_AUDIT_TEXT_LIMIT,
): string {
  const text = value ?? "";
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

function toAudit(row: ImChatAuditRow): ImChatAudit {
  return {
    id: row.id,
    channelId: row.channel_id,
    channelName: row.channel_name,
    platform: row.platform,
    sessionId: row.session_id,
    workspace: row.workspace,
    actor: row.actor,
    actorName: row.actor_name,
    chatType: row.chat_type,
    conversationId: row.conversation_id,
    question: row.question,
    answer: row.answer,
    status: row.status === "error" ? "error" : "ok",
    error: row.error,
    durationMs: row.duration_ms,
    toolCalls: row.tool_calls,
    citations: row.citations,
    createdAt: row.created_at,
  };
}

/**
 * 写入一条 IM 审计。**失败不抛错**（返回 null），调用方无需担心审计拖垮问答链路。
 */
export function recordImChatAudit(input: ImChatAuditInput): ImChatAudit | null {
  try {
    const id = randomUUID();
    const createdAt = input.createdAt ?? Date.now();
    const row: ImChatAudit = {
      id,
      channelId: input.channelId ?? null,
      channelName: input.channelName ?? null,
      platform: input.platform,
      sessionId: input.sessionId ?? null,
      workspace: input.workspace?.trim() || DEFAULT_WORKSPACE_ID,
      actor: input.actor ?? null,
      // 昵称可能含特殊字符或过长：裁剪到 200 字符，避免审计表被单条脏数据撑爆。
      actorName: truncateAuditText(input.actorName, 200) || null,
      chatType: input.chatType ?? "p2p",
      conversationId: input.conversationId ?? null,
      question: truncateAuditText(input.question),
      answer: truncateAuditText(input.answer),
      status: input.status === "error" ? "error" : "ok",
      error: input.error ? truncateAuditText(input.error, 500) : null,
      durationMs: Number.isFinite(input.durationMs)
        ? Math.max(0, Math.floor(input.durationMs!))
        : 0,
      toolCalls: Number.isFinite(input.toolCalls) ? Math.max(0, Math.floor(input.toolCalls!)) : 0,
      citations: Number.isFinite(input.citations) ? Math.max(0, Math.floor(input.citations!)) : 0,
      createdAt,
    };
    database()
      .prepare(
        `INSERT INTO im_chat_audits (
           id, channel_id, channel_name, platform, session_id, workspace, actor, actor_name,
           chat_type, conversation_id, question, answer, status, error, duration_ms,
           tool_calls, citations, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.channelId,
        row.channelName,
        row.platform,
        row.sessionId,
        row.workspace,
        row.actor,
        row.actorName,
        row.chatType,
        row.conversationId,
        row.question,
        row.answer,
        row.status,
        row.error,
        row.durationMs,
        row.toolCalls,
        row.citations,
        row.createdAt,
      );
    return row;
  } catch {
    return null;
  }
}

function buildWhere(filters: ImChatAuditFilters): {
  where: string;
  params: (string | number)[];
} {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (filters.workspace) {
    conditions.push("workspace = ?");
    params.push(filters.workspace);
  }
  if (filters.platform) {
    conditions.push("platform = ?");
    params.push(filters.platform);
  }
  if (filters.channelId) {
    conditions.push("channel_id = ?");
    params.push(filters.channelId);
  }
  if (filters.actor) {
    // 对话者筛选同时匹配平台用户 ID 与可读姓名（输入客户名也能查到）。
    conditions.push("(actor = ? OR actor_name = ?)");
    params.push(filters.actor, filters.actor);
  }
  if (filters.chatType) {
    conditions.push("chat_type = ?");
    params.push(filters.chatType);
  }
  if (filters.status) {
    conditions.push("status = ?");
    params.push(filters.status);
  }
  if (Number.isFinite(filters.from)) {
    conditions.push("created_at >= ?");
    params.push(filters.from as number);
  }
  if (Number.isFinite(filters.to)) {
    conditions.push("created_at <= ?");
    params.push(filters.to as number);
  }
  if (filters.keyword?.trim()) {
    // 关键词同时覆盖问答正文与对话者（ID/姓名），输入客户名可直接追溯其全部对话。
    conditions.push(
      "(instr(lower(question), lower(?)) > 0 OR instr(lower(answer), lower(?)) > 0 OR instr(lower(COALESCE(actor, '')), lower(?)) > 0 OR instr(lower(COALESCE(actor_name, '')), lower(?)) > 0)",
    );
    const keyword = filters.keyword.trim();
    params.push(keyword, keyword, keyword, keyword);
  }
  return {
    where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

export function listImChatAudits(filters: ImChatAuditFilters = {}): {
  items: ImChatAudit[];
  total: number;
} {
  const db = database();
  const { where, params } = buildWhere(filters);
  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM im_chat_audits ${where}`)
    .get(...params) as { total: number };
  const limit = Math.max(1, Math.min(500, Math.floor(filters.limit ?? 50)));
  const offset = Math.max(0, Math.floor(filters.offset ?? 0));
  const rows = db
    .prepare(
      `SELECT * FROM im_chat_audits ${where}
       ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as unknown as ImChatAuditRow[];
  return { items: rows.map(toAudit), total };
}

export function countImChatAudits(filters: ImChatAuditFilters = {}): number {
  const db = database();
  const { where, params } = buildWhere(filters);
  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM im_chat_audits ${where}`)
    .get(...params) as { total: number };
  return total;
}

export function getImChatAudit(id: string): ImChatAudit | null {
  const row = database().prepare(`SELECT * FROM im_chat_audits WHERE id = ?`).get(id) as unknown as
    ImChatAuditRow | undefined;
  return row ? toAudit(row) : null;
}
