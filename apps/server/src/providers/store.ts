import { randomUUID } from "node:crypto";
import { openDb } from "../db.js";
import { decryptProviderKey, encryptProviderKey, maskProviderKey } from "./crypto.js";
import { isProviderFormat, type ProviderFormat } from "./formats.js";

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  enabled: boolean;
  isDefault: boolean;
  apiKeyMasked: string | null;
  format: ProviderFormat;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderWithKey extends Provider {
  apiKey: string | null;
}

export interface ProviderInput {
  id?: string;
  name: string;
  baseUrl: string;
  apiKey?: string | null;
  models: string[];
  enabled?: boolean;
  format?: ProviderFormat;
}

interface ProviderRow {
  id: string;
  name: string;
  base_url: string;
  api_key_enc: string | null;
  models_json: string;
  enabled: number;
  is_default: number;
  format: string;
  created_at: string;
  updated_at: string;
}

function now(): string {
  return new Date().toISOString();
}

function normalizeModels(models: unknown): string[] {
  if (!Array.isArray(models)) throw new Error("models must be an array");
  const normalized = [
    ...new Set(
      models
        .filter((model): model is string => typeof model === "string")
        .map((model) => model.trim())
        .filter(Boolean),
    ),
  ];
  if (normalized.length === 0) throw new Error("models must contain at least one model");
  return normalized;
}

function normalizeInput(
  input: ProviderInput,
): Required<Pick<ProviderInput, "name" | "baseUrl" | "models" | "format">> &
  Pick<ProviderInput, "apiKey" | "enabled"> {
  const name = input.name?.trim();
  const baseUrl = input.baseUrl?.trim().replace(/\/$/, "");
  if (!name) throw new Error("name is required");
  if (!baseUrl) throw new Error("baseUrl is required");
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("baseUrl must be a valid URL");
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("baseUrl must use http or https");
  const format = input.format ?? "openai-chat";
  if (!isProviderFormat(format)) throw new Error(`unknown provider format: ${format}`);
  return {
    name,
    baseUrl,
    models: normalizeModels(input.models),
    apiKey: input.apiKey === undefined ? undefined : input.apiKey?.trim() || null,
    enabled: input.enabled !== false,
    format,
  };
}

function rowToProvider(row: ProviderRow, includeKey = false): Provider | ProviderWithKey {
  const models = JSON.parse(row.models_json) as unknown;
  const parsedModels = Array.isArray(models)
    ? models.filter((model): model is string => typeof model === "string")
    : [];
  const format = isProviderFormat(row.format) ? row.format : "openai-chat";
  const base = {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    models: parsedModels,
    enabled: row.enabled === 1,
    isDefault: row.is_default === 1,
    apiKeyMasked: maskProviderKey(row.api_key_enc ? decryptProviderKey(row.api_key_enc) : null),
    format,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } satisfies Provider;
  if (!includeKey) return base;
  return { ...base, apiKey: row.api_key_enc ? decryptProviderKey(row.api_key_enc) : null };
}

function getRow(id: string): ProviderRow | null {
  const row = openDb().prepare(`SELECT * FROM providers WHERE id = ?`).get(id) as
    ProviderRow | undefined;
  return row ?? null;
}

export function listProviders(options?: { includeDisabled?: boolean }): Provider[] {
  const rows = openDb()
    .prepare(
      `SELECT * FROM providers ${options?.includeDisabled ? "" : "WHERE enabled = 1"} ORDER BY is_default DESC, name ASC`,
    )
    .all() as unknown as ProviderRow[];
  return rows.map((row) => rowToProvider(row));
}

export function getProvider(
  id: string,
  options?: { requireEnabled?: boolean },
): ProviderWithKey | null {
  const row = getRow(id);
  if (!row || (options?.requireEnabled && row.enabled !== 1)) return null;
  return rowToProvider(row, true) as ProviderWithKey;
}

export function createProvider(input: ProviderInput): Provider {
  const normalized = normalizeInput(input);
  const id = input.id?.trim() || randomUUID();
  const timestamp = now();
  const encrypted = normalized.apiKey ? encryptProviderKey(normalized.apiKey) : null;
  openDb()
    .prepare(
      `INSERT INTO providers (id, name, base_url, api_key_enc, models_json, enabled, is_default, format, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    )
    .run(
      id,
      normalized.name,
      normalized.baseUrl,
      encrypted,
      JSON.stringify(normalized.models),
      normalized.enabled ? 1 : 0,
      normalized.format,
      timestamp,
      timestamp,
    );
  return getProvider(id)!;
}

export function updateProvider(
  id: string,
  input: Partial<Omit<ProviderInput, "id">>,
): Provider | null {
  const current = getRow(id);
  if (!current) return null;
  const normalized = normalizeInput({
    name: input.name ?? current.name,
    baseUrl: input.baseUrl ?? current.base_url,
    models: input.models ?? JSON.parse(current.models_json),
    enabled: input.enabled ?? current.enabled === 1,
    apiKey: input.apiKey,
    format: input.format ?? (isProviderFormat(current.format) ? current.format : "openai-chat"),
  });
  const encrypted =
    normalized.apiKey === undefined
      ? current.api_key_enc
      : normalized.apiKey
        ? encryptProviderKey(normalized.apiKey)
        : null;
  openDb()
    .prepare(
      `UPDATE providers SET name = ?, base_url = ?, api_key_enc = ?, models_json = ?, enabled = ?, format = ?, updated_at = ? WHERE id = ?`,
    )
    .run(
      normalized.name,
      normalized.baseUrl,
      encrypted,
      JSON.stringify(normalized.models),
      normalized.enabled ? 1 : 0,
      normalized.format,
      now(),
      id,
    );
  return getProvider(id);
}

export function deleteProvider(id: string): "deleted" | "not_found" | "default" {
  const current = getRow(id);
  if (!current) return "not_found";
  // 默认 Provider（id 为 "default" 或标记为 is_default）不可删除，
  // 因为 /api/chat 与 Workflow LLM 节点在未指定 providerId 时会路由到它。
  if (current.id === "default" || current.is_default === 1) return "default";
  openDb().prepare(`DELETE FROM providers WHERE id = ?`).run(id);
  return "deleted";
}

export function ensureDefaultProvider(): Provider | null {
  // Provider 完全由设置页面管理，不再从环境变量注入默认 Provider。
  return getProvider("default");
}

export interface ProbeModelsParams {
  baseUrl: string;
  apiKey?: string | null;
}

/** 向目标的 /models 端点发起请求并解析模型 id 列表（不落库）。 */
export async function probeProviderModels(params: ProbeModelsParams): Promise<string[]> {
  const baseUrl = params.baseUrl?.trim().replace(/\/$/, "");
  if (!baseUrl) throw new Error("baseUrl is required");
  const headers: Record<string, string> = {};
  if (params.apiKey) headers.authorization = `Bearer ${params.apiKey}`;
  const response = await fetch(`${baseUrl}/models`, { headers });
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error("该 Provider 不支持自动获取，请手动填写");
    }
    throw new Error(`Provider model request failed (${response.status})`);
  }
  const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
  if (!Array.isArray(body.data)) {
    throw new Error("该 Provider 不支持自动获取，请手动填写");
  }
  return body.data
    .map((item) => (typeof item?.id === "string" ? item.id.trim() : ""))
    .filter(Boolean);
}

export async function fetchProviderModels(id: string): Promise<string[]> {
  const provider = getProvider(id, { requireEnabled: false });
  if (!provider) throw new Error("provider not found");
  return probeProviderModels({ baseUrl: provider.baseUrl, apiKey: provider.apiKey });
}

export function initializeProviders(): Provider | null {
  return ensureDefaultProvider();
}
