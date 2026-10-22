import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { logDebugDuration } from "./trace.js";

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

const DEFAULT_DB_PATH = resolve(import.meta.dirname, "../data/chat.sqlite");

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
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New chat',
      updated_at INTEGER NOT NULL,
      workspace_id TEXT NOT NULL DEFAULT 'default',
      -- 来源：'web'（Web/App 聊天）或 'im'（IM 机器人）。
      -- IM 会话统一标记为 'im'，平台信息放在 actor / channel_id 上，
      -- 这样筛选时只需按 source 切分，不必为每个平台各建一列。
      source TEXT NOT NULL DEFAULT 'web',
      -- IM 来源的平台用户 id（私聊与群聊都记录），Web 会话为 NULL。
      actor TEXT,
      -- IM 来源的渠道 id，Web 会话为 NULL。
      channel_id TEXT
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
      format TEXT NOT NULL DEFAULT 'openai-chat',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS im_channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      platform TEXT NOT NULL,
      app_id TEXT NOT NULL,
      app_secret_enc TEXT,
      encrypt_key_enc TEXT,
      rag_sources_json TEXT NOT NULL DEFAULT '[]',
      sql_sources_json TEXT NOT NULL DEFAULT '[]',
      mcp_tools_json TEXT NOT NULL DEFAULT '[]',
      rag_top_k INTEGER NOT NULL DEFAULT 5,
      require_mention INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      -- 渠道所属 workspace：IM 问答产生的会话与用量都归到该空间。
      workspace_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schema_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      connector TEXT NOT NULL DEFAULT 'mysql',
      connection_url_enc TEXT NOT NULL,
      database_name TEXT,
      schema_name TEXT,
      table_filter_json TEXT NOT NULL DEFAULT '[]',
      semantic_profile TEXT NOT NULL DEFAULT 'generic',
      enabled INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      sync_status TEXT NOT NULL DEFAULT 'idle',
      last_synced_at TEXT,
      last_error TEXT,
      table_count INTEGER NOT NULL DEFAULT 0,
      relation_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_schema_sources_default
      ON schema_sources(is_default) WHERE is_default = 1;

    CREATE TABLE IF NOT EXISTS mcp_gateway_config (
      id TEXT PRIMARY KEY,
      gateway_url TEXT NOT NULL,
      api_key_enc TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS metric_definitions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT,
      unit TEXT,
      caliber_json TEXT NOT NULL,
      source_id TEXT,
      tables_json TEXT NOT NULL DEFAULT '[]',
      synonyms_json TEXT NOT NULL DEFAULT '[]',
      tags_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active',
      version INTEGER NOT NULL DEFAULT 1,
      owner TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_metric_definitions_category
      ON metric_definitions(category);
    CREATE INDEX IF NOT EXISTS idx_metric_definitions_status
      ON metric_definitions(status);

    CREATE TABLE IF NOT EXISTS caliber_configs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      config_json TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_caliber_configs_default
      ON caliber_configs(is_default) WHERE is_default = 1;

    -- 用量计量（商业化计费与成本对账的依据）：只做新增，不改动现有表。
    -- kind='chat' 记录整轮对话的 token 与工具轮数；kind='tool' 记录单次工具调用。
    CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('chat', 'tool')),
      workspace_id TEXT,
      session_id TEXT,
      provider_id TEXT,
      model TEXT,
      tool_kind TEXT,
      tool_name TEXT,
      source TEXT NOT NULL DEFAULT 'web_chat',
      requests INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ok',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_usage_events_created_at
      ON usage_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_events_kind_created_at
      ON usage_events(kind, created_at);

    -- workspace：只做「一层隔离」，不引入完整多租户。
    -- 老数据一律归属 default，避免迁移期间出现无归属资源。
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- 发布态：把一个「知识库 + 资源绑定 + 提示词」打包成员工可用的入口。
    -- 与 Studio 管理台分离：终端用户只看到问答，不需要理解 Provider/资源抽屉。
    CREATE TABLE IF NOT EXISTS published_apps (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT 'default',
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      welcome TEXT NOT NULL DEFAULT '',
      suggestions_json TEXT NOT NULL DEFAULT '[]',
      resources_json TEXT NOT NULL DEFAULT '{}',
      allowed_groups_json TEXT NOT NULL DEFAULT '[]',
      provider_id TEXT,
      model TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      -- 访问控制：public 任何人可访问；token 需要携带访问口令（分享链接即凭证）。
      access_mode TEXT NOT NULL DEFAULT 'public',
      access_token_hash TEXT,
      access_token_hint TEXT,
      -- 配额：每分钟请求数上限 + 每日 token 预算（0 表示不限）。
      rate_limit_per_minute INTEGER NOT NULL DEFAULT 20,
      daily_token_budget INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_published_apps_workspace
      ON published_apps(workspace_id, created_at DESC);

    -- 短时身份断言的重放防护。jti 全库唯一；过期行按需清理。
    CREATE TABLE IF NOT EXISTS viewer_assertion_replays (
      replay_key TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_viewer_assertion_replays_expires
      ON viewer_assertion_replays(expires_at);

    -- 文档同步连接器(SKU A6):管理员配置外部知识源并增量同步进知识库。
    -- 只做新增表,不改动现有 schema;删除连接器时级联清理运行记录与去重台账。
    CREATE TABLE IF NOT EXISTS connectors (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      base_url TEXT,
      credentials_enc TEXT,
      credential_keys_json TEXT NOT NULL DEFAULT '[]',
      filter_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_status TEXT,
      last_synced_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS connector_sync_runs (
      id TEXT PRIMARY KEY,
      connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      pulled INTEGER NOT NULL DEFAULT 0,
      ingested INTEGER NOT NULL DEFAULT 0,
      skipped INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      failures_json TEXT NOT NULL DEFAULT '[]',
      error TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_connector_sync_runs_connector
      ON connector_sync_runs(connector_id, started_at DESC);

    -- 幂等台账:同一 (connector_id, external_id) 记录内容哈希,哈希未变即跳过。
    CREATE TABLE IF NOT EXISTS connector_documents (
      connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
      external_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      rag_source TEXT NOT NULL,
      byte_size INTEGER NOT NULL DEFAULT 0,
      ingested_at TEXT NOT NULL,
      PRIMARY KEY (connector_id, external_id)
    );
  `);

  migrateMessagesTable(db);
  migrateProvidersTable(db);
  migrateSchemaSourcesTable(db);
  migrateImChannelsTable(db);
  // workspace 列先补齐（老库可能连 workspace_id 都没有），再补来源列。
  migrateWorkspaceColumns(db);
  migrateSessionSourceColumns(db);
  migrateUsageColumns(db);
  ensureDefaultWorkspace(db);

  logDebugDuration("db.open", startedAt, { path });
  return db;
}

function migrateUsageColumns(database: DatabaseSync): void {
  const columns = new Set(
    (database.prepare("PRAGMA table_info(usage_events)").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  if (columns.has("source") && columns.has("requests")) return;
  database.exec("BEGIN");
  try {
    if (!columns.has("source")) {
      database.exec("ALTER TABLE usage_events ADD COLUMN source TEXT NOT NULL DEFAULT 'web_chat'");
    }
    if (!columns.has("requests")) {
      database.exec("ALTER TABLE usage_events ADD COLUMN requests INTEGER NOT NULL DEFAULT 0");
      database.exec("UPDATE usage_events SET requests = 1 WHERE kind = 'chat'");
    }
    database
      .prepare("UPDATE usage_events SET workspace_id = ? WHERE workspace_id IS NULL")
      .run(DEFAULT_WORKSPACE_ID);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/** 为存量库补齐 workspace 归属列：新建库由 CREATE TABLE 直接带上，老库走 ALTER。 */
function migrateWorkspaceColumns(database: DatabaseSync): void {
  const additions: Array<[string, string, string]> = [
    ["sessions", "workspace_id", `TEXT NOT NULL DEFAULT '${DEFAULT_WORKSPACE_ID}'`],
    ["usage_events", "workspace_id", "TEXT"],
  ];
  for (const [table, column, definition] of additions) {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    if (columns.length === 0) continue;
    if (!new Set(columns.map((row) => row.name)).has(column)) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
  database.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id)`);
  database.exec(
    `CREATE INDEX IF NOT EXISTS idx_usage_events_workspace ON usage_events(workspace_id, created_at)`,
  );
  migratePublishedAppColumns(database);
}

/** 发布应用新增的访问控制与配额列：老库走 ALTER，默认值保证行为向后兼容。 */
function migratePublishedAppColumns(database: DatabaseSync): void {
  const rows = database.prepare(`PRAGMA table_info(published_apps)`).all() as Array<{
    name: string;
  }>;
  if (rows.length === 0) return;
  const columns = new Set(rows.map((row) => row.name));
  const additions = [
    ["access_mode", "TEXT NOT NULL DEFAULT 'public'"],
    ["access_token_hash", "TEXT"],
    ["access_token_hint", "TEXT"],
    ["rate_limit_per_minute", "INTEGER NOT NULL DEFAULT 20"],
    ["daily_token_budget", "INTEGER NOT NULL DEFAULT 0"],
    ["allowed_groups_json", "TEXT NOT NULL DEFAULT '[]'"],
  ] as const;
  for (const [name, definition] of additions) {
    if (!columns.has(name)) {
      database.exec(`ALTER TABLE published_apps ADD COLUMN ${name} ${definition}`);
    }
  }
}

/** 默认 workspace 必须存在，否则新会话与老数据的归属会落空。 */
function ensureDefaultWorkspace(database: DatabaseSync): void {
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO workspaces (id, name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(DEFAULT_WORKSPACE_ID, "默认空间", "存量数据与未指定归属的资源", now, now);
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

function providerColumns(database: DatabaseSync): Set<string> {
  const rows = database.prepare(`PRAGMA table_info(providers)`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

/** Add format column on legacy DBs (defaults to OpenAI Chat). */
function migrateProvidersTable(database: DatabaseSync): void {
  if (!providerColumns(database).has("format")) {
    database.exec(`ALTER TABLE providers ADD COLUMN format TEXT NOT NULL DEFAULT 'openai-chat'`);
  }
}

function migrateSchemaSourcesTable(database: DatabaseSync): void {
  const rows = database.prepare(`PRAGMA table_info(schema_sources)`).all() as Array<{
    name: string;
  }>;
  const columns = new Set(rows.map((row) => row.name));
  const additions = [
    ["schema_name", "TEXT"],
    ["sync_status", "TEXT NOT NULL DEFAULT 'idle'"],
    ["last_synced_at", "TEXT"],
    ["last_error", "TEXT"],
    ["table_count", "INTEGER NOT NULL DEFAULT 0"],
    ["relation_count", "INTEGER NOT NULL DEFAULT 0"],
  ] as const;
  for (const [name, definition] of additions) {
    if (!columns.has(name)) {
      database.exec(`ALTER TABLE schema_sources ADD COLUMN ${name} ${definition}`);
    }
  }
}

/**
 * 为存量库补齐 im_channels.sql_sources_json / mcp_tools_json 列。
 * 新建库由 CREATE TABLE 直接带上；老库必须 ALTER，否则 store 的 SELECT * 会缺列。
 */
function migrateImChannelsTable(database: DatabaseSync): void {
  const rows = database.prepare(`PRAGMA table_info(im_channels)`).all() as Array<{ name: string }>;
  if (rows.length === 0) return;
  const columns = new Set(rows.map((row) => row.name));
  const additions: Array<[string, string]> = [
    ["sql_sources_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["mcp_tools_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["workspace_id", `TEXT NOT NULL DEFAULT '${DEFAULT_WORKSPACE_ID}'`],
  ];
  for (const [name, definition] of additions) {
    if (!columns.has(name)) {
      database.exec(`ALTER TABLE im_channels ADD COLUMN ${name} ${definition}`);
    }
  }
}

/**
 * 为存量库补齐 sessions 的来源列（source / actor / channel_id）。
 * 存量会话一律视为 Web 会话（source='web'），避免出现在 IM 审计里。
 */
function migrateSessionSourceColumns(database: DatabaseSync): void {
  const rows = database.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
  if (rows.length === 0) return;
  const columns = new Set(rows.map((row) => row.name));
  const additions: Array<[string, string]> = [
    ["source", "TEXT NOT NULL DEFAULT 'web'"],
    ["actor", "TEXT"],
    ["channel_id", "TEXT"],
  ];
  for (const [name, definition] of additions) {
    if (!columns.has(name)) {
      database.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${definition}`);
    }
  }
  database.exec(
    `CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source, workspace_id, updated_at DESC)`,
  );
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
  const sessions = summaries.map((s) => getSession(s.id)).filter((s): s is Session => s !== null);
  // N+1 查询(每个会话单独取消息);会话数变大时耗时会明显上升,debug 下单独计时便于发现。
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

  // 同 id 再插入（重新生成、断网重试、双击）不能抛 UNIQUE，也不能改写已有行。
  // 会话或角色不一致时拒绝，避免把别的会话的消息吞掉。
  const existing = database
    .prepare(
      `SELECT id, session_id AS sessionId, role, content, created_at AS createdAt, status,
              tool_call_id AS toolCallId, tool_name AS toolName
       FROM messages WHERE id = ?`,
    )
    .get(id) as
    | {
        id: string;
        sessionId: string;
        role: Role;
        content: string;
        createdAt: number;
        status: MessageStatus | null;
        toolCallId: string | null;
        toolName: string | null;
      }
    | undefined;
  if (existing) {
    if (existing.sessionId !== sessionId || existing.role !== message.role) return null;
    return {
      id: existing.id,
      role: existing.role,
      content: existing.content,
      createdAt: existing.createdAt,
      status: existing.status ?? "complete",
      ...(existing.toolCallId ? { tool_call_id: existing.toolCallId } : {}),
      ...(existing.toolName ? { tool_name: existing.toolName } : {}),
    };
  }

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

export function ensureSession(
  sessionId: string,
  workspaceId?: string,
  options: SessionCreateOptions = {},
): Session {
  const existing = getSession(sessionId);
  if (existing) return existing;
  return createSession({ id: sessionId, ...(workspaceId ? { workspaceId } : {}), ...options });
}
