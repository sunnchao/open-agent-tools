import { randomUUID } from "node:crypto";
import { openDb } from "../db.js";
import { decryptConfigSecret, encryptConfigSecret } from "../providers/crypto.js";
import {
  normalizeFilter,
  ragSourceName,
  type ConnectorConfig,
  type ConnectorFilter,
  type ConnectorType,
  isConnectorType,
} from "./types.js";

export type ConnectorSyncStatus = "idle" | "success" | "partial" | "error";

export interface Connector {
  id: string;
  name: string;
  type: ConnectorType;
  baseUrl: string | null;
  filter: ConnectorFilter;
  enabled: boolean;
  /** 凭据字段名(不含值),用于前端展示「已配置」状态。 */
  credentialKeys: string[];
  hasCredential: boolean;
  lastStatus: ConnectorSyncStatus | null;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorWithSecret extends Connector {
  credentials: Record<string, string>;
}

export interface ConnectorInput {
  id?: string;
  name: string;
  type: ConnectorType;
  baseUrl?: string | null;
  credentials?: Record<string, string> | null;
  filter?: Partial<ConnectorFilter> | null;
  enabled?: boolean;
}

export interface ConnectorDocumentRecord {
  connectorId: string;
  externalId: string;
  title: string;
  contentHash: string;
  ragSource: string;
  byteSize: number;
  ingestedAt: string;
}

export interface ConnectorSyncFailure {
  externalId: string;
  reason: string;
}

export interface ConnectorSyncRun {
  id: string;
  connectorId: string;
  status: ConnectorSyncStatus;
  pulled: number;
  ingested: number;
  skipped: number;
  failed: number;
  failures: ConnectorSyncFailure[];
  error: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

interface ConnectorRow {
  id: string;
  name: string;
  type: string;
  base_url: string | null;
  credentials_enc: string | null;
  credential_keys_json: string;
  filter_json: string;
  enabled: number;
  last_status: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SyncRunRow {
  id: string;
  connector_id: string;
  status: string;
  pulled: number;
  ingested: number;
  skipped: number;
  failed: number;
  failures_json: string;
  error: string | null;
  started_at: string;
  finished_at: string;
  duration_ms: number;
}

function now(): string {
  return new Date().toISOString();
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function isSyncStatus(value: unknown): value is ConnectorSyncStatus {
  return value === "idle" || value === "success" || value === "partial" || value === "error";
}

function parseCredentialKeys(raw: string): string[] {
  const keys = parseJson<unknown>(raw, []);
  return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string") : [];
}

function sanitizeCredentials(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string") result[key] = raw;
  }
  return result;
}

function rowToConnector(row: ConnectorRow, includeSecret = false): Connector | ConnectorWithSecret {
  const credentialKeys = parseCredentialKeys(row.credential_keys_json);
  const base: Connector = {
    id: row.id,
    name: row.name,
    type: isConnectorType(row.type) ? row.type : "http",
    baseUrl: row.base_url,
    filter: normalizeFilter(parseJson<unknown>(row.filter_json, {})),
    enabled: row.enabled === 1,
    credentialKeys,
    hasCredential: credentialKeys.length > 0 || Boolean(row.credentials_enc),
    lastStatus: isSyncStatus(row.last_status) ? row.last_status : null,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (!includeSecret) return base;
  const credentials = row.credentials_enc
    ? sanitizeCredentials(parseJson(decryptConfigSecret(row.credentials_enc), {}))
    : {};
  return { ...base, credentials };
}

function getRow(id: string): ConnectorRow | null {
  return (
    (openDb().prepare(`SELECT * FROM connectors WHERE id = ?`).get(id) as
      ConnectorRow | undefined) ?? null
  );
}

export function listConnectors(options?: { includeDisabled?: boolean }): Connector[] {
  const rows = openDb()
    .prepare(
      `SELECT * FROM connectors ${options?.includeDisabled ? "" : "WHERE enabled = 1"} ORDER BY name ASC`,
    )
    .all() as unknown as ConnectorRow[];
  return rows.map((row) => rowToConnector(row) as Connector);
}

export function getConnector(
  id: string,
  options?: { requireEnabled?: boolean },
): ConnectorWithSecret | null {
  const row = getRow(id);
  if (!row || (options?.requireEnabled && row.enabled !== 1)) return null;
  return rowToConnector(row, true) as ConnectorWithSecret;
}

export function createConnector(input: ConnectorInput): Connector {
  const name = input.name?.trim();
  if (!name) throw new Error("name is required");
  if (!isConnectorType(input.type))
    throw new Error(`unsupported connector type: ${String(input.type)}`);
  const id = input.id?.trim() || randomUUID();
  const credentials = sanitizeCredentials(input.credentials);
  const timestamp = now();
  openDb()
    .prepare(
      `INSERT INTO connectors (id, name, type, base_url, credentials_enc, credential_keys_json, filter_json, enabled, last_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)`,
    )
    .run(
      id,
      name,
      input.type,
      input.baseUrl?.trim() || null,
      hasCredentials(credentials) ? encryptConfigSecret(JSON.stringify(credentials)) : null,
      JSON.stringify(Object.keys(credentials)),
      JSON.stringify(normalizeFilter(input.filter ?? {})),
      input.enabled === false ? 0 : 1,
      timestamp,
      timestamp,
    );
  return rowToConnector(getRow(id)!) as Connector;
}

export function updateConnector(
  id: string,
  input: Partial<Omit<ConnectorInput, "id">>,
): Connector | null {
  const current = getRow(id);
  if (!current) return null;
  const name = input.name?.trim() || current.name;
  const type = input.type ?? (isConnectorType(current.type) ? current.type : "http");
  if (!isConnectorType(type)) throw new Error(`unsupported connector type: ${String(type)}`);
  // credentials 未传时沿用原密文;传了(即使为空对象)则整体覆写。
  let credentialsEnc = current.credentials_enc;
  let credentialKeys = parseCredentialKeys(current.credential_keys_json);
  if (input.credentials !== undefined) {
    const credentials = sanitizeCredentials(input.credentials);
    credentialsEnc = hasCredentials(credentials)
      ? encryptConfigSecret(JSON.stringify(credentials))
      : null;
    credentialKeys = Object.keys(credentials);
  }
  const baseUrl = input.baseUrl === undefined ? current.base_url : input.baseUrl?.trim() || null;
  openDb()
    .prepare(
      `UPDATE connectors SET name = ?, type = ?, base_url = ?, credentials_enc = ?, credential_keys_json = ?, filter_json = ?, enabled = ?, updated_at = ? WHERE id = ?`,
    )
    .run(
      name,
      type,
      baseUrl,
      credentialsEnc,
      JSON.stringify(credentialKeys),
      input.filter === undefined
        ? current.filter_json
        : JSON.stringify(normalizeFilter(input.filter)),
      (input.enabled ?? current.enabled === 1) ? 1 : 0,
      now(),
      id,
    );
  return rowToConnector(getRow(id)!) as Connector;
}

export function deleteConnector(id: string): "deleted" | "not_found" {
  const current = getRow(id);
  if (!current) return "not_found";
  openDb().prepare(`DELETE FROM connectors WHERE id = ?`).run(id);
  return "deleted";
}

function hasCredentials(credentials: Record<string, string>): boolean {
  return Object.keys(credentials).length > 0;
}

export function updateConnectorSyncState(
  id: string,
  patch: { status: ConnectorSyncStatus; lastSyncedAt?: string | null },
): void {
  openDb()
    .prepare(
      `UPDATE connectors
       SET last_status = ?,
           last_synced_at = CASE WHEN ? = 1 THEN ? ELSE last_synced_at END,
           updated_at = ?
       WHERE id = ?`,
    )
    .run(
      patch.status,
      patch.lastSyncedAt !== undefined ? 1 : 0,
      patch.lastSyncedAt ?? null,
      now(),
      id,
    );
}

export function recordSyncRun(input: {
  connectorId: string;
  status: ConnectorSyncStatus;
  pulled: number;
  ingested: number;
  skipped: number;
  failed: number;
  failures: ConnectorSyncFailure[];
  error: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}): ConnectorSyncRun {
  const id = randomUUID();
  openDb()
    .prepare(
      `INSERT INTO connector_sync_runs (id, connector_id, status, pulled, ingested, skipped, failed, failures_json, error, started_at, finished_at, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.connectorId,
      input.status,
      input.pulled,
      input.ingested,
      input.skipped,
      input.failed,
      JSON.stringify(input.failures),
      input.error,
      input.startedAt,
      input.finishedAt,
      input.durationMs,
    );
  return { id, ...input };
}

function rowToSyncRun(row: SyncRunRow): ConnectorSyncRun {
  return {
    id: row.id,
    connectorId: row.connector_id,
    status: isSyncStatus(row.status) ? row.status : "error",
    pulled: row.pulled,
    ingested: row.ingested,
    skipped: row.skipped,
    failed: row.failed,
    failures: parseJson<ConnectorSyncFailure[]>(row.failures_json, []),
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
  };
}

export function listSyncRuns(connectorId: string, limit = 10): ConnectorSyncRun[] {
  const capped = Math.max(1, Math.min(50, Math.floor(limit) || 10));
  const rows = openDb()
    .prepare(
      `SELECT * FROM connector_sync_runs WHERE connector_id = ? ORDER BY started_at DESC LIMIT ?`,
    )
    .all(connectorId, capped) as unknown as SyncRunRow[];
  return rows.map(rowToSyncRun);
}

export function getConnectorDocument(
  connectorId: string,
  externalId: string,
): ConnectorDocumentRecord | null {
  const row = openDb()
    .prepare(
      `SELECT connector_id AS connectorId, external_id AS externalId, title, content_hash AS contentHash,
              rag_source AS ragSource, byte_size AS byteSize, ingested_at AS ingestedAt
       FROM connector_documents WHERE connector_id = ? AND external_id = ?`,
    )
    .get(connectorId, externalId) as ConnectorDocumentRecord | undefined;
  return row ?? null;
}

export function upsertConnectorDocument(input: {
  connectorId: string;
  externalId: string;
  title: string;
  contentHash: string;
  ragSource?: string;
  byteSize: number;
  ingestedAt: string;
}): void {
  const ragSource = input.ragSource ?? ragSourceName(input.connectorId, input.externalId);
  openDb()
    .prepare(
      `INSERT INTO connector_documents (connector_id, external_id, title, content_hash, rag_source, byte_size, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(connector_id, external_id) DO UPDATE SET
         title = excluded.title,
         content_hash = excluded.content_hash,
         rag_source = excluded.rag_source,
         byte_size = excluded.byte_size,
         ingested_at = excluded.ingested_at`,
    )
    .run(
      input.connectorId,
      input.externalId,
      input.title,
      input.contentHash,
      ragSource,
      input.byteSize,
      input.ingestedAt,
    );
}

export function countConnectorDocuments(connectorId: string): number {
  const row = openDb()
    .prepare(`SELECT COUNT(*) AS count FROM connector_documents WHERE connector_id = ?`)
    .get(connectorId) as { count: number };
  return row.count;
}

/** 把持久化配置转成连接器实现所需的运行时配置(含解密凭据)。 */
export function toConnectorConfig(connector: ConnectorWithSecret): ConnectorConfig {
  return {
    id: connector.id,
    name: connector.name,
    type: connector.type,
    baseUrl: connector.baseUrl,
    credentials: connector.credentials,
    filter: connector.filter,
    enabled: connector.enabled,
  };
}
