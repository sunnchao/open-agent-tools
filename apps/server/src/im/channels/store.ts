import { randomUUID } from "node:crypto";
import { openDb } from "../../db.js";
import { decryptProviderKey, encryptProviderKey, maskProviderKey } from "../../providers/crypto.js";
import { isImPlatform, type ImPlatform } from "../types.js";

export { isImPlatform, type ImPlatform };

export interface ImChannel {
  id: string;
  name: string;
  platform: ImPlatform;
  appId: string;
  appSecretMasked: string | null;
  encryptKeyMasked: string | null;
  ragSources: string[];
  ragTopK: number;
  requireMention: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ImChannelWithSecret extends ImChannel {
  appSecret: string | null;
  encryptKey: string | null;
}

export interface ImChannelInput {
  id?: string;
  name: string;
  platform: ImPlatform;
  appId: string;
  appSecret?: string;
  encryptKey?: string;
  ragSources?: string[];
  ragTopK?: number;
  requireMention?: boolean;
  enabled?: boolean;
}

interface ImChannelRow {
  id: string;
  name: string;
  platform: string;
  app_id: string;
  app_secret_enc: string | null;
  encrypt_key_enc: string | null;
  rag_sources_json: string;
  rag_top_k: number;
  require_mention: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function now(): string {
  return new Date().toISOString();
}

function normalizeSources(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("ragSources must be an array");
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

function normalizeInput(input: ImChannelInput): {
  name: string;
  platform: ImPlatform;
  appId: string;
  appSecret: string | undefined;
  encryptKey: string | undefined;
  ragSources: string[];
  ragTopK: number;
  requireMention: boolean;
  enabled: boolean;
} {
  const name = input.name?.trim();
  const appId = input.appId?.trim();
  if (!name) throw new Error("name is required");
  if (!isImPlatform(input.platform)) throw new Error(`unsupported IM platform: ${input.platform}`);
  if (!appId) throw new Error("appId is required");
  const ragTopK = Number.isFinite(input.ragTopK)
    ? Math.min(20, Math.max(1, Math.floor(input.ragTopK as number)))
    : 5;
  return {
    name,
    platform: input.platform,
    appId,
    // 空串视为未提供（编辑留空 = 不修改密钥）。
    appSecret: input.appSecret === undefined ? undefined : input.appSecret.trim() || undefined,
    encryptKey: input.encryptKey === undefined ? undefined : input.encryptKey.trim() || undefined,
    ragSources: normalizeSources(input.ragSources),
    ragTopK,
    requireMention: input.requireMention !== false,
    enabled: input.enabled !== false,
  };
}

function rowToChannel(row: ImChannelRow, includeSecret = false): ImChannel | ImChannelWithSecret {
  const parsed = JSON.parse(row.rag_sources_json) as unknown;
  const base = {
    id: row.id,
    name: row.name,
    platform: (isImPlatform(row.platform) ? row.platform : "feishu") as ImPlatform,
    appId: row.app_id,
    appSecretMasked: row.app_secret_enc
      ? maskProviderKey(decryptProviderKey(row.app_secret_enc))
      : null,
    encryptKeyMasked: row.encrypt_key_enc
      ? maskProviderKey(decryptProviderKey(row.encrypt_key_enc))
      : null,
    ragSources: Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [],
    ragTopK: row.rag_top_k,
    requireMention: row.require_mention === 1,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } satisfies ImChannel;
  if (!includeSecret) return base;
  return {
    ...base,
    appSecret: row.app_secret_enc ? decryptProviderKey(row.app_secret_enc) : null,
    encryptKey: row.encrypt_key_enc ? decryptProviderKey(row.encrypt_key_enc) : null,
  };
}

function getRow(id: string): ImChannelRow | null {
  const row = openDb().prepare(`SELECT * FROM im_channels WHERE id = ?`).get(id) as
    ImChannelRow | undefined;
  return row ?? null;
}

export function listChannels(options?: { includeDisabled?: boolean }): ImChannel[] {
  const rows = openDb()
    .prepare(
      `SELECT * FROM im_channels ${options?.includeDisabled ? "" : "WHERE enabled = 1"} ORDER BY created_at ASC`,
    )
    .all() as unknown as ImChannelRow[];
  return rows.map((row) => rowToChannel(row));
}

export function getChannel(
  id: string,
  options?: { includeDisabled?: boolean },
): ImChannelWithSecret | null {
  const row = getRow(id);
  if (!row || (!options?.includeDisabled && row.enabled !== 1)) return null;
  return rowToChannel(row, true) as ImChannelWithSecret;
}

export function createChannel(input: ImChannelInput): ImChannel {
  const normalized = normalizeInput(input);
  const id = input.id?.trim() || randomUUID();
  const timestamp = now();
  const appSecretEnc = normalized.appSecret ? encryptProviderKey(normalized.appSecret) : null;
  const encryptKeyEnc = normalized.encryptKey ? encryptProviderKey(normalized.encryptKey) : null;
  openDb()
    .prepare(
      `INSERT INTO im_channels (id, name, platform, app_id, app_secret_enc, encrypt_key_enc, rag_sources_json, rag_top_k, require_mention, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      normalized.name,
      normalized.platform,
      normalized.appId,
      appSecretEnc,
      encryptKeyEnc,
      JSON.stringify(normalized.ragSources),
      normalized.ragTopK,
      normalized.requireMention ? 1 : 0,
      normalized.enabled ? 1 : 0,
      timestamp,
      timestamp,
    );
  return toPublic(getChannel(id, { includeDisabled: true })!);
}

/** 剥离明文密钥，仅返回可安全序列化给前端的字段。 */
function toPublic(channel: ImChannelWithSecret): ImChannel {
  return {
    id: channel.id,
    name: channel.name,
    platform: channel.platform,
    appId: channel.appId,
    appSecretMasked: channel.appSecretMasked,
    encryptKeyMasked: channel.encryptKeyMasked,
    ragSources: channel.ragSources,
    ragTopK: channel.ragTopK,
    requireMention: channel.requireMention,
    enabled: channel.enabled,
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt,
  };
}

export function updateChannel(
  id: string,
  input: Partial<Omit<ImChannelInput, "id">>,
): ImChannel | null {
  const current = getRow(id);
  if (!current) return null;
  const parsedSources = JSON.parse(current.rag_sources_json) as unknown;
  const normalized = normalizeInput({
    name: input.name ?? current.name,
    platform: input.platform ?? (isImPlatform(current.platform) ? current.platform : "feishu"),
    appId: input.appId ?? current.app_id,
    appSecret: input.appSecret,
    encryptKey: input.encryptKey,
    ragSources: input.ragSources ?? (Array.isArray(parsedSources) ? parsedSources : []),
    ragTopK: input.ragTopK ?? current.rag_top_k,
    requireMention: input.requireMention ?? current.require_mention === 1,
    enabled: input.enabled ?? current.enabled === 1,
  });
  const appSecretEnc =
    normalized.appSecret === undefined
      ? current.app_secret_enc
      : normalized.appSecret
        ? encryptProviderKey(normalized.appSecret)
        : null;
  const encryptKeyEnc =
    normalized.encryptKey === undefined
      ? current.encrypt_key_enc
      : normalized.encryptKey
        ? encryptProviderKey(normalized.encryptKey)
        : null;
  openDb()
    .prepare(
      `UPDATE im_channels SET name = ?, platform = ?, app_id = ?, app_secret_enc = ?, encrypt_key_enc = ?, rag_sources_json = ?, rag_top_k = ?, require_mention = ?, enabled = ?, updated_at = ? WHERE id = ?`,
    )
    .run(
      normalized.name,
      normalized.platform,
      normalized.appId,
      appSecretEnc,
      encryptKeyEnc,
      JSON.stringify(normalized.ragSources),
      normalized.ragTopK,
      normalized.requireMention ? 1 : 0,
      normalized.enabled ? 1 : 0,
      now(),
      id,
    );
  return toPublic(getChannel(id, { includeDisabled: true })!);
}

export function deleteChannel(id: string): boolean {
  const current = getRow(id);
  if (!current) return false;
  openDb().prepare(`DELETE FROM im_channels WHERE id = ?`).run(id);
  return true;
}
