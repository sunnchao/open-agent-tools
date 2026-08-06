import { randomUUID } from "node:crypto";
import { OpenAI } from "openai";
import { openDb } from "../db.js";
import { decryptProviderKey, encryptProviderKey, maskProviderKey } from "./crypto.js";

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  enabled: boolean;
  isDefault: boolean;
  apiKeyMasked: string | null;
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
}

interface ProviderRow {
  id: string;
  name: string;
  base_url: string;
  api_key_enc: string | null;
  models_json: string;
  enabled: number;
  is_default: number;
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
): Required<Pick<ProviderInput, "name" | "baseUrl" | "models">> &
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
  return {
    name,
    baseUrl,
    models: normalizeModels(input.models),
    apiKey: input.apiKey === undefined ? undefined : input.apiKey?.trim() || null,
    enabled: input.enabled !== false,
  };
}

function rowToProvider(row: ProviderRow, includeKey = false): Provider | ProviderWithKey {
  const models = JSON.parse(row.models_json) as unknown;
  const parsedModels = Array.isArray(models)
    ? models.filter((model): model is string => typeof model === "string")
    : [];
  const base = {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    models: parsedModels,
    enabled: row.enabled === 1,
    isDefault: row.is_default === 1,
    apiKeyMasked: maskProviderKey(row.api_key_enc ? decryptProviderKey(row.api_key_enc) : null),
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
      `INSERT INTO providers (id, name, base_url, api_key_enc, models_json, enabled, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(
      id,
      normalized.name,
      normalized.baseUrl,
      encrypted,
      JSON.stringify(normalized.models),
      normalized.enabled ? 1 : 0,
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
  });
  const encrypted =
    normalized.apiKey === undefined
      ? current.api_key_enc
      : normalized.apiKey
        ? encryptProviderKey(normalized.apiKey)
        : null;
  openDb()
    .prepare(
      `UPDATE providers SET name = ?, base_url = ?, api_key_enc = ?, models_json = ?, enabled = ?, updated_at = ? WHERE id = ?`,
    )
    .run(
      normalized.name,
      normalized.baseUrl,
      encrypted,
      JSON.stringify(normalized.models),
      normalized.enabled ? 1 : 0,
      now(),
      id,
    );
  return getProvider(id);
}

export function deleteProvider(id: string): "deleted" | "not_found" | "default" {
  const current = getRow(id);
  if (!current) return "not_found";
  if (current.is_default === 1) return "default";
  openDb().prepare(`DELETE FROM providers WHERE id = ?`).run(id);
  return "deleted";
}

export function ensureDefaultProvider(): Provider {
  const existing = getProvider("default");
  if (existing) return existing;
  const model = process.env.OPENAI_API_MODEL?.trim() || "gpt-4o-mini";
  const baseUrl = process.env.OPENAI_API_BASE_URL?.trim() || "https://api.openai.com/v1";
  const input: ProviderInput = {
    id: "default",
    name: "OpenAI",
    baseUrl,
    models: [model],
    enabled: true,
    apiKey: process.env.OPENAI_API_KEY?.trim() || null,
  };
  const normalized = normalizeInput(input);
  const timestamp = now();
  const encrypted = normalized.apiKey ? encryptProviderKey(normalized.apiKey) : null;
  openDb()
    .prepare(
      `INSERT INTO providers (id, name, base_url, api_key_enc, models_json, enabled, is_default, created_at, updated_at)
       VALUES ('default', ?, ?, ?, ?, 1, 1, ?, ?)`,
    )
    .run(
      normalized.name,
      normalized.baseUrl,
      encrypted,
      JSON.stringify(normalized.models),
      timestamp,
      timestamp,
    );
  return getProvider("default")!;
}

export function createProviderClient(provider: ProviderWithKey): OpenAI {
  return new OpenAI({ apiKey: provider.apiKey ?? "", baseURL: provider.baseUrl });
}

export async function fetchProviderModels(id: string): Promise<string[]> {
  const provider = getProvider(id, { requireEnabled: false });
  if (!provider) throw new Error("provider not found");
  const headers: Record<string, string> = {};
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  const response = await fetch(`${provider.baseUrl}/models`, { headers });
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

export function initializeProviders(): Provider {
  return ensureDefaultProvider();
}
