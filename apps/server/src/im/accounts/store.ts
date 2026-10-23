import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_WORKSPACE_ID, openDb } from "../../db.js";
import { getProvider, listProviders } from "../../providers/store.js";
import { ensureImChatAuditStorage } from "../audit.js";
import type { ImChatType, ImExternalUserIdType, ImPlatform } from "../types.js";

export type ImAccountBindingStatus = "unbound" | "valid" | "invalid";
export type ImAccountChannelState = "all" | "existing" | "deleted";

export interface ImChannelAccount {
  id: string;
  workspaceId: string;
  channelId: string;
  channelName: string;
  platform: ImPlatform;
  externalUserId: string;
  externalUserIdType: ImExternalUserIdType | null;
  externalName: string | null;
  displayName: string | null;
  remark: string | null;
  providerId: string | null;
  providerName: string | null;
  model: string | null;
  bindingStatus: ImAccountBindingStatus;
  firstInteractedAt: number;
  lastInteractedAt: number;
  lastConversationId: string | null;
  lastChatType: ImChatType | null;
  channelDeleted: boolean;
  channelDeletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImAccountInteractionInput {
  channelId: string;
  channelName: string;
  platform: ImPlatform;
  workspaceId?: string | null;
  externalUserId: string;
  externalUserIdType?: ImExternalUserIdType | null;
  externalName?: string | null;
  conversationId?: string | null;
  chatType: ImChatType;
  occurredAt?: number;
}

export interface ImAccountFilters {
  workspaceId: string;
  channelId?: string;
  platform?: string;
  keyword?: string;
  channelState?: ImAccountChannelState;
  limit?: number;
  offset?: number;
}

export interface ImAccountUpdate {
  displayName?: string | null;
  remark?: string | null;
  providerId?: string | null;
  model?: string | null;
}

export interface ImAccountModelBinding {
  providerId: string;
  model: string;
}

interface ImAccountRow {
  id: string;
  workspace_id: string;
  channel_id: string;
  channel_name: string;
  platform: string;
  external_user_id: string;
  external_user_id_type: string | null;
  external_name: string | null;
  display_name: string | null;
  remark: string | null;
  provider_id: string | null;
  model: string | null;
  first_interacted_at: number;
  last_interacted_at: number;
  last_conversation_id: string | null;
  last_chat_type: string | null;
  channel_deleted_at: string | null;
  created_at: string;
  updated_at: string;
  live_channel_id: string | null;
  live_channel_name: string | null;
}

const BACKFILL_KEY = "im_accounts_audit_backfill_v1";
const initializedDatabases = new WeakSet<DatabaseSync>();

function nowIso(): string {
  return new Date().toISOString();
}

function trimmed(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().slice(0, maxLength);
  return text || null;
}

function platformValue(value: string): ImPlatform {
  return value === "dingtalk" ? "dingtalk" : "feishu";
}

function userIdTypeValue(value: string | null): ImExternalUserIdType | null {
  if (
    value === "feishu_open_id" ||
    value === "dingtalk_staff_id" ||
    value === "dingtalk_sender_id" ||
    value === "dingtalk_user_id"
  ) {
    return value;
  }
  return null;
}

function chatTypeValue(value: string | null): ImChatType | null {
  return value === "p2p" || value === "group" ? value : null;
}

function backfillImAccounts(db: DatabaseSync): void {
  const applied = db
    .prepare(`SELECT 1 AS applied FROM im_account_migrations WHERE key = ?`)
    .get(BACKFILL_KEY);
  if (applied) return;

  const rows = db
    .prepare(
      `WITH ranked AS (
         SELECT channel_id, actor, platform, workspace, channel_name, actor_name, created_at,
                conversation_id, chat_type,
                MIN(created_at) OVER (PARTITION BY channel_id, actor) AS first_at,
                MAX(created_at) OVER (PARTITION BY channel_id, actor) AS last_at,
                (
                  SELECT recent_name.actor_name
                  FROM im_chat_audits AS recent_name
                  WHERE recent_name.channel_id = im_chat_audits.channel_id
                    AND recent_name.actor = im_chat_audits.actor
                    AND recent_name.actor_name IS NOT NULL
                    AND trim(recent_name.actor_name) <> ''
                  ORDER BY recent_name.created_at DESC, recent_name.rowid DESC
                  LIMIT 1
                ) AS latest_actor_name,
                ROW_NUMBER() OVER (
                  PARTITION BY channel_id, actor
                  ORDER BY created_at DESC, rowid DESC
                ) AS row_number
         FROM im_chat_audits
         WHERE channel_id IS NOT NULL AND trim(channel_id) <> ''
           AND actor IS NOT NULL AND trim(actor) <> ''
       )
       SELECT ranked.*, channels.id AS live_channel_id, channels.name AS live_channel_name
       FROM ranked
       LEFT JOIN im_channels AS channels ON channels.id = ranked.channel_id
       WHERE ranked.row_number = 1`,
    )
    .all() as Array<{
    channel_id: string;
    actor: string;
    platform: string;
    workspace: string;
    channel_name: string | null;
    actor_name: string | null;
    latest_actor_name: string | null;
    conversation_id: string | null;
    chat_type: string | null;
    first_at: number;
    last_at: number;
    live_channel_id: string | null;
    live_channel_name: string | null;
  }>;

  const insert = db.prepare(
    `INSERT INTO im_channel_accounts (
       id, workspace_id, channel_id, channel_name, platform, external_user_id,
       external_user_id_type, external_name, display_name, remark, provider_id, model,
       first_interacted_at, last_interacted_at, last_conversation_id, last_chat_type,
       channel_deleted_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(channel_id, external_user_id) DO NOTHING`,
  );
  const timestamp = nowIso();

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      const lastAt = Number(row.last_at) || Number(row.first_at) || Date.now();
      const channelDeletedAt = row.live_channel_id ? null : timestamp;
      insert.run(
        randomUUID(),
        row.workspace || DEFAULT_WORKSPACE_ID,
        row.channel_id,
        row.live_channel_name ?? row.channel_name ?? "已删除渠道",
        platformValue(row.platform),
        row.actor,
        row.platform === "dingtalk" ? "dingtalk_user_id" : "feishu_open_id",
        trimmed(row.latest_actor_name ?? row.actor_name, 200),
        Number(row.first_at) || lastAt,
        lastAt,
        trimmed(row.conversation_id, 500),
        chatTypeValue(row.chat_type),
        channelDeletedAt,
        new Date(Number(row.first_at) || lastAt).toISOString(),
        timestamp,
      );
    }
    db.prepare(
      `INSERT INTO im_account_migrations (key, applied_at) VALUES (?, ?)
       ON CONFLICT(key) DO NOTHING`,
    ).run(BACKFILL_KEY, timestamp);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** 建表由 db.ts 负责；这里完成一次性历史回填并按数据库实例缓存。 */
export function initializeImAccounts(): void {
  const db = openDb();
  if (initializedDatabases.has(db)) return;
  ensureImChatAuditStorage();
  backfillImAccounts(db);
  initializedDatabases.add(db);
}

export function recordImAccountInteraction(input: ImAccountInteractionInput): void {
  initializeImAccounts();
  const channelId = input.channelId.trim();
  const externalUserId = input.externalUserId.trim();
  if (!channelId || !externalUserId) return;

  const occurredAt = Number.isFinite(input.occurredAt) ? Number(input.occurredAt) : Date.now();
  const timestamp = nowIso();
  openDb()
    .prepare(
      `INSERT INTO im_channel_accounts (
         id, workspace_id, channel_id, channel_name, platform, external_user_id,
         external_user_id_type, external_name, display_name, remark, provider_id, model,
         first_interacted_at, last_interacted_at, last_conversation_id, last_chat_type,
         channel_deleted_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT(channel_id, external_user_id) DO UPDATE SET
         workspace_id = CASE
           WHEN EXISTS (SELECT 1 FROM im_channels WHERE id = excluded.channel_id)
             THEN excluded.workspace_id
           ELSE im_channel_accounts.workspace_id
         END,
         channel_name = CASE
           WHEN EXISTS (SELECT 1 FROM im_channels WHERE id = excluded.channel_id)
             THEN excluded.channel_name
           ELSE im_channel_accounts.channel_name
         END,
         platform = CASE
           WHEN EXISTS (SELECT 1 FROM im_channels WHERE id = excluded.channel_id)
             THEN excluded.platform
           ELSE im_channel_accounts.platform
         END,
         external_user_id_type = COALESCE(
           excluded.external_user_id_type,
           im_channel_accounts.external_user_id_type
         ),
         external_name = COALESCE(NULLIF(excluded.external_name, ''), im_channel_accounts.external_name),
         last_interacted_at = MAX(
           im_channel_accounts.last_interacted_at,
           excluded.last_interacted_at
         ),
         last_conversation_id = CASE
           WHEN excluded.last_interacted_at >= im_channel_accounts.last_interacted_at
             THEN excluded.last_conversation_id
           ELSE im_channel_accounts.last_conversation_id
         END,
         last_chat_type = CASE
           WHEN excluded.last_interacted_at >= im_channel_accounts.last_interacted_at
             THEN excluded.last_chat_type
           ELSE im_channel_accounts.last_chat_type
         END,
         channel_deleted_at = CASE
           WHEN EXISTS (SELECT 1 FROM im_channels WHERE id = excluded.channel_id) THEN NULL
           ELSE im_channel_accounts.channel_deleted_at
         END,
         updated_at = excluded.updated_at`,
    )
    .run(
      randomUUID(),
      input.workspaceId?.trim() || DEFAULT_WORKSPACE_ID,
      channelId,
      input.channelName.trim().slice(0, 200) || "未命名渠道",
      input.platform,
      externalUserId.slice(0, 500),
      input.externalUserIdType ?? null,
      trimmed(input.externalName, 200),
      occurredAt,
      occurredAt,
      trimmed(input.conversationId, 500),
      input.chatType,
      timestamp,
      timestamp,
    );
}

export function updateImAccountExternalName(
  channelId: string,
  externalUserId: string,
  name: string | null,
): void {
  const normalized = trimmed(name, 200);
  if (!normalized) return;
  initializeImAccounts();
  openDb()
    .prepare(
      `UPDATE im_channel_accounts
       SET external_name = ?, updated_at = ?
       WHERE channel_id = ? AND external_user_id = ?`,
    )
    .run(normalized, nowIso(), channelId.trim(), externalUserId.trim());
}

export function resolveImAccountModel(
  channelId: string,
  externalUserId: string,
): ImAccountModelBinding | null {
  initializeImAccounts();
  const row = openDb()
    .prepare(
      `SELECT provider_id, model
       FROM im_channel_accounts
       WHERE channel_id = ? AND external_user_id = ?`,
    )
    .get(channelId.trim(), externalUserId.trim()) as
    { provider_id: string | null; model: string | null } | undefined;
  if (!row?.provider_id || !row.model) return null;
  const provider = getProvider(row.provider_id, { requireEnabled: true });
  if (!provider || !provider.apiKey || !provider.models.includes(row.model)) {
    return null;
  }
  return { providerId: provider.id, model: row.model };
}

function accountFromRow(
  row: ImAccountRow,
  providers: Map<
    string,
    { name: string; enabled: boolean; models: string[]; apiKeyMasked: string | null }
  >,
): ImChannelAccount {
  const provider = row.provider_id ? providers.get(row.provider_id) : undefined;
  const bindingStatus: ImAccountBindingStatus =
    !row.provider_id && !row.model
      ? "unbound"
      : row.provider_id &&
          row.model &&
          provider?.enabled &&
          provider.models.includes(row.model) &&
          provider.apiKeyMasked
        ? "valid"
        : "invalid";
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    channelName: row.live_channel_name ?? row.channel_name,
    platform: platformValue(row.platform),
    externalUserId: row.external_user_id,
    externalUserIdType: userIdTypeValue(row.external_user_id_type),
    externalName: row.external_name,
    displayName: row.display_name,
    remark: row.remark,
    providerId: row.provider_id,
    providerName: provider?.name ?? null,
    model: row.model,
    bindingStatus,
    firstInteractedAt: row.first_interacted_at,
    lastInteractedAt: row.last_interacted_at,
    lastConversationId: row.last_conversation_id,
    lastChatType: chatTypeValue(row.last_chat_type),
    channelDeleted: Boolean(row.channel_deleted_at) || !row.live_channel_id,
    channelDeletedAt: row.channel_deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function providerMap() {
  return new Map(
    listProviders({ includeDisabled: true }).map((provider) => [
      provider.id,
      {
        name: provider.name,
        enabled: provider.enabled,
        models: provider.models,
        apiKeyMasked: provider.apiKeyMasked,
      },
    ]),
  );
}

export function listImAccounts(filters: ImAccountFilters): {
  items: ImChannelAccount[];
  total: number;
} {
  initializeImAccounts();
  const db = openDb();
  const conditions = ["accounts.workspace_id = ?"];
  const params: Array<string | number> = [filters.workspaceId];
  if (filters.channelId?.trim()) {
    conditions.push("accounts.channel_id = ?");
    params.push(filters.channelId.trim());
  }
  if (filters.platform?.trim()) {
    conditions.push("accounts.platform = ?");
    params.push(filters.platform.trim());
  }
  if (filters.channelState === "existing") {
    conditions.push("accounts.channel_deleted_at IS NULL AND channels.id IS NOT NULL");
  } else if (filters.channelState === "deleted") {
    conditions.push("(accounts.channel_deleted_at IS NOT NULL OR channels.id IS NULL)");
  }
  if (filters.keyword?.trim()) {
    conditions.push(
      `(instr(lower(accounts.external_user_id), lower(?)) > 0
        OR instr(lower(COALESCE(accounts.external_name, '')), lower(?)) > 0
        OR instr(lower(COALESCE(accounts.display_name, '')), lower(?)) > 0
        OR instr(lower(COALESCE(channels.name, accounts.channel_name)), lower(?)) > 0)`,
    );
    const keyword = filters.keyword.trim();
    params.push(keyword, keyword, keyword, keyword);
  }
  const where = `WHERE ${conditions.join(" AND ")}`;
  const { total } = db
    .prepare(
      `SELECT COUNT(*) AS total
       FROM im_channel_accounts AS accounts
       LEFT JOIN im_channels AS channels ON channels.id = accounts.channel_id
       ${where}`,
    )
    .get(...params) as { total: number };
  const limit = Math.max(1, Math.min(200, Math.floor(filters.limit ?? 50)));
  const offset = Math.max(0, Math.floor(filters.offset ?? 0));
  const rows = db
    .prepare(
      `SELECT accounts.*, channels.id AS live_channel_id, channels.name AS live_channel_name
       FROM im_channel_accounts AS accounts
       LEFT JOIN im_channels AS channels ON channels.id = accounts.channel_id
       ${where}
       ORDER BY accounts.last_interacted_at DESC, accounts.rowid DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as unknown as ImAccountRow[];
  const providers = providerMap();
  return { items: rows.map((row) => accountFromRow(row, providers)), total };
}

function getAccountRow(id: string, workspaceId: string): ImAccountRow | null {
  initializeImAccounts();
  const row = openDb()
    .prepare(
      `SELECT accounts.*, channels.id AS live_channel_id, channels.name AS live_channel_name
       FROM im_channel_accounts AS accounts
       LEFT JOIN im_channels AS channels ON channels.id = accounts.channel_id
       WHERE accounts.id = ? AND accounts.workspace_id = ?`,
    )
    .get(id, workspaceId) as ImAccountRow | undefined;
  return row ?? null;
}

export function updateImAccount(
  id: string,
  workspaceId: string,
  input: ImAccountUpdate,
): ImChannelAccount | null {
  const current = getAccountRow(id, workspaceId);
  if (!current) return null;

  const hasDisplayName = Object.prototype.hasOwnProperty.call(input, "displayName");
  const hasRemark = Object.prototype.hasOwnProperty.call(input, "remark");
  const hasBinding =
    Object.prototype.hasOwnProperty.call(input, "providerId") ||
    Object.prototype.hasOwnProperty.call(input, "model");

  let providerId = current.provider_id;
  let model = current.model;
  if (hasBinding) {
    if (
      !Object.prototype.hasOwnProperty.call(input, "providerId") ||
      !Object.prototype.hasOwnProperty.call(input, "model")
    ) {
      throw new Error("providerId and model must be updated together");
    }
    providerId = trimmed(input.providerId, 200);
    model = trimmed(input.model, 200);
    if (!providerId !== !model) {
      throw new Error("providerId and model must both be set or both be empty");
    }
    if (providerId && model) {
      const provider = getProvider(providerId, { requireEnabled: true });
      if (!provider) throw new Error("provider not found or disabled");
      if (!provider.models.includes(model)) {
        throw new Error(`model is not available on provider: ${model}`);
      }
    }
  }

  const displayName = hasDisplayName ? trimmed(input.displayName, 200) : current.display_name;
  const remark = hasRemark ? trimmed(input.remark, 1000) : current.remark;
  openDb()
    .prepare(
      `UPDATE im_channel_accounts
       SET display_name = ?, remark = ?, provider_id = ?, model = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ?`,
    )
    .run(displayName, remark, providerId, model, nowIso(), id, workspaceId);
  const updated = getAccountRow(id, workspaceId);
  return updated ? accountFromRow(updated, providerMap()) : null;
}

/** 渠道删除前保存当前渠道快照；账号本身永久保留。 */
export function archiveImChannelAccounts(
  channelId: string,
  channel: { name: string; platform: ImPlatform; workspaceId: string },
): void {
  initializeImAccounts();
  const timestamp = nowIso();
  openDb()
    .prepare(
      `UPDATE im_channel_accounts
       SET channel_name = ?, platform = ?, workspace_id = ?,
           channel_deleted_at = COALESCE(channel_deleted_at, ?), updated_at = ?
       WHERE channel_id = ?`,
    )
    .run(
      channel.name.trim().slice(0, 200) || "已删除渠道",
      channel.platform,
      channel.workspaceId,
      timestamp,
      timestamp,
      channelId,
    );
}
