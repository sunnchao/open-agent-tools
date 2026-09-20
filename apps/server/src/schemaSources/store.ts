import { randomUUID } from "node:crypto";
import { createMysqlPool } from "@open-agent-tools/database/mysql";
import { createPostgresPool } from "@open-agent-tools/database/postgres";
import { openDb } from "../db.js";
import { decryptConfigSecret, encryptConfigSecret } from "../providers/crypto.js";

export type SchemaSourceConnector = "mysql" | "postgresql";
export type SchemaSemanticProfile = "generic" | "oneapi";
export type SchemaSourceSyncStatus = "idle" | "syncing" | "ready" | "error";

export interface SchemaSource {
  id: string;
  name: string;
  connector: SchemaSourceConnector;
  endpoint: string;
  databaseName: string | null;
  schemaName: string | null;
  tableFilter: string[];
  semanticProfile: SchemaSemanticProfile;
  enabled: boolean;
  isDefault: boolean;
  managedByEnv: boolean;
  hasCredential: boolean;
  syncStatus: SchemaSourceSyncStatus;
  lastSyncedAt: string | null;
  lastError: string | null;
  tableCount: number;
  relationCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SchemaSourceWithSecret extends SchemaSource {
  connectionString: string;
}

export interface SchemaSourceInput {
  id?: string;
  name: string;
  connector?: SchemaSourceConnector;
  connectionString?: string;
  databaseName?: string | null;
  schemaName?: string | null;
  tableFilter?: string[];
  semanticProfile?: SchemaSemanticProfile;
  enabled?: boolean;
}

interface SchemaSourceRow {
  id: string;
  name: string;
  connector: string;
  connection_url_enc: string;
  database_name: string | null;
  schema_name: string | null;
  table_filter_json: string;
  semantic_profile: string;
  enabled: number;
  is_default: number;
  sync_status: string;
  last_synced_at: string | null;
  last_error: string | null;
  table_count: number;
  relation_count: number;
  created_at: string;
  updated_at: string;
}

function now(): string {
  return new Date().toISOString();
}

function isConnector(value: unknown): value is SchemaSourceConnector {
  return value === "mysql" || value === "postgresql";
}

function connectorForProtocol(protocol: string): SchemaSourceConnector | null {
  if (protocol === "mysql:") return "mysql";
  if (protocol === "postgres:" || protocol === "postgresql:") return "postgresql";
  return null;
}

function connectorForConnectionString(connectionString: string): SchemaSourceConnector | null {
  try {
    return connectorForProtocol(new URL(connectionString).protocol);
  } catch {
    return null;
  }
}

function isProfile(value: unknown): value is SchemaSemanticProfile {
  return value === "generic" || value === "oneapi";
}

function isSyncStatus(value: unknown): value is SchemaSourceSyncStatus {
  return value === "idle" || value === "syncing" || value === "ready" || value === "error";
}

function normalizeFilters(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function normalizeConnectionString(value: string, connector?: SchemaSourceConnector): string {
  const connectionString = value.trim();
  if (!connectionString) throw new Error("connectionString is required");
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("connectionString must be a valid MySQL or PostgreSQL URL");
  }
  const inferred = connectorForProtocol(parsed.protocol);
  if (!inferred) throw new Error("only mysql:// or postgresql:// schema sources are supported");
  if (connector && connector !== inferred) {
    throw new Error(`connectionString protocol does not match ${connector} connector`);
  }
  if (!parsed.hostname) throw new Error("connectionString host is required");
  return connectionString;
}

function endpointOf(
  connectionString: string,
  databaseName?: string | null,
  schemaName?: string | null,
): string {
  const parsed = new URL(connectionString);
  const database = databaseName?.trim() || parsed.pathname.replace(/^\//, "");
  const endpoint = `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}${database ? `/${database}` : ""}`;
  return schemaName?.trim() ? `${endpoint}#${schemaName.trim()}` : endpoint;
}

function parseFilters(raw: string): string[] {
  try {
    return normalizeFilters(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

function rowToSource(
  row: SchemaSourceRow,
  includeSecret = false,
): SchemaSource | SchemaSourceWithSecret {
  const connectionString = decryptConfigSecret(row.connection_url_enc);
  const connector = isConnector(row.connector)
    ? row.connector
    : (connectorForConnectionString(connectionString) ?? "mysql");
  const base: SchemaSource = {
    id: row.id,
    name: row.name,
    connector,
    endpoint: endpointOf(connectionString, row.database_name, row.schema_name),
    databaseName: row.database_name,
    schemaName: row.schema_name,
    tableFilter: parseFilters(row.table_filter_json),
    semanticProfile: isProfile(row.semantic_profile) ? row.semantic_profile : "generic",
    enabled: row.enabled === 1,
    isDefault: row.is_default === 1,
    managedByEnv: false,
    hasCredential: true,
    syncStatus: isSyncStatus(row.sync_status) ? row.sync_status : "idle",
    lastSyncedAt: row.last_synced_at,
    lastError: row.last_error,
    tableCount: row.table_count,
    relationCount: row.relation_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return includeSecret ? { ...base, connectionString } : base;
}

function getRow(id: string): SchemaSourceRow | null {
  return (
    (openDb().prepare(`SELECT * FROM schema_sources WHERE id = ?`).get(id) as
      SchemaSourceRow | undefined) ?? null
  );
}

const environmentSyncState: Pick<
  SchemaSource,
  "syncStatus" | "lastSyncedAt" | "lastError" | "tableCount" | "relationCount"
> = {
  syncStatus: "idle",
  lastSyncedAt: null,
  lastError: null,
  tableCount: 0,
  relationCount: 0,
};

function environmentSource(): SchemaSourceWithSecret | null {
  const connectionString =
    process.env.SCHEMA_SOURCE_URL?.trim() || process.env.REPORT_DATABASE_URL?.trim();
  if (!connectionString) return null;
  const configuredConnector = process.env.SCHEMA_SOURCE_CONNECTOR?.trim();
  const connector = configuredConnector
    ? configuredConnector === "postgres"
      ? "postgresql"
      : configuredConnector
    : connectorForConnectionString(connectionString);
  if (!connector || !isConnector(connector)) {
    throw new Error("SCHEMA_SOURCE_CONNECTOR must be mysql or postgresql");
  }
  const normalized = normalizeConnectionString(connectionString, connector);
  const databaseName = process.env.SCHEMA_SOURCE_DATABASE?.trim() || null;
  const schemaName = process.env.SCHEMA_SOURCE_SCHEMA?.trim() || null;
  const timestamp = "environment";
  const hasStoredDefault = Boolean(
    openDb().prepare(`SELECT id FROM schema_sources WHERE is_default = 1 LIMIT 1`).get(),
  );
  return {
    id: "environment-report",
    name: process.env.SCHEMA_SOURCE_NAME?.trim() || "环境变量数据源",
    connector,
    endpoint: endpointOf(normalized, databaseName, schemaName),
    databaseName,
    schemaName,
    tableFilter: normalizeFilters(process.env.SCHEMA_SOURCE_TABLE_FILTER?.split(",")),
    semanticProfile: isProfile(process.env.SCHEMA_SOURCE_PROFILE)
      ? process.env.SCHEMA_SOURCE_PROFILE
      : "oneapi",
    enabled: true,
    isDefault: !hasStoredDefault,
    managedByEnv: true,
    hasCredential: true,
    ...environmentSyncState,
    connectionString: normalized,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function withoutSecret(source: SchemaSourceWithSecret): SchemaSource {
  const { connectionString: _connectionString, ...metadata } = source;
  return metadata;
}

export function listSchemaSources(options?: { includeDisabled?: boolean }): SchemaSource[] {
  const rows = openDb()
    .prepare(
      `SELECT * FROM schema_sources ${options?.includeDisabled ? "" : "WHERE enabled = 1"} ORDER BY is_default DESC, name ASC`,
    )
    .all() as unknown as SchemaSourceRow[];
  const sources = rows.map((row) => rowToSource(row) as SchemaSource);
  const fromEnv = environmentSource();
  if (fromEnv && (options?.includeDisabled || fromEnv.enabled)) {
    sources.push(withoutSecret(fromEnv));
  }
  return sources.sort(
    (left, right) =>
      Number(right.isDefault) - Number(left.isDefault) || left.name.localeCompare(right.name),
  );
}

export function getSchemaSource(
  id: string,
  options?: { requireEnabled?: boolean },
): SchemaSourceWithSecret | null {
  const fromEnv = environmentSource();
  if (id === fromEnv?.id) return fromEnv;
  const row = getRow(id);
  if (!row || (options?.requireEnabled && row.enabled !== 1)) return null;
  return rowToSource(row, true) as SchemaSourceWithSecret;
}

export function getDefaultSchemaSource(options?: {
  requireEnabled?: boolean;
}): SchemaSourceWithSecret | null {
  const row = openDb()
    .prepare(
      `SELECT * FROM schema_sources WHERE is_default = 1 ${options?.requireEnabled ? "AND enabled = 1" : ""} LIMIT 1`,
    )
    .get() as SchemaSourceRow | undefined;
  if (row) return rowToSource(row, true) as SchemaSourceWithSecret;
  const fromEnv = environmentSource();
  return fromEnv && (!options?.requireEnabled || fromEnv.enabled) ? fromEnv : null;
}

export function createSchemaSource(input: SchemaSourceInput): SchemaSource {
  const name = input.name?.trim();
  if (!name) throw new Error("name is required");
  const connector =
    input.connector ?? connectorForConnectionString(input.connectionString ?? "") ?? "mysql";
  if (!isConnector(connector)) throw new Error(`unsupported connector: ${String(connector)}`);
  const connectionString = normalizeConnectionString(input.connectionString ?? "", connector);
  const databaseName = input.databaseName?.trim() || null;
  const schemaName = input.schemaName?.trim() || null;
  const semanticProfile = input.semanticProfile ?? "generic";
  if (!isProfile(semanticProfile)) throw new Error("unknown semantic profile");
  const id = input.id?.trim() || randomUUID();
  if (id === "environment-report") throw new Error("reserved schema source id");
  const timestamp = now();
  const shouldDefault = !getDefaultSchemaSource();
  openDb()
    .prepare(
      `INSERT INTO schema_sources (id, name, connector, connection_url_enc, database_name, schema_name, table_filter_json, semantic_profile, enabled, is_default, sync_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)`,
    )
    .run(
      id,
      name,
      connector,
      encryptConfigSecret(connectionString),
      databaseName,
      schemaName,
      JSON.stringify(normalizeFilters(input.tableFilter)),
      semanticProfile,
      input.enabled === false ? 0 : 1,
      shouldDefault && input.enabled !== false ? 1 : 0,
      timestamp,
      timestamp,
    );
  return rowToSource(getRow(id)!) as SchemaSource;
}

export function updateSchemaSource(
  id: string,
  input: Partial<Omit<SchemaSourceInput, "id">>,
): SchemaSource | null {
  const current = getRow(id);
  if (!current) return null;
  const name = input.name?.trim() || current.name;
  const connector =
    input.connector ??
    (input.connectionString?.trim()
      ? connectorForConnectionString(input.connectionString)
      : isConnector(current.connector)
        ? current.connector
        : "mysql");
  if (!isConnector(connector)) throw new Error(`unsupported connector: ${String(connector)}`);
  const connectionString = input.connectionString?.trim()
    ? normalizeConnectionString(input.connectionString, connector)
    : normalizeConnectionString(decryptConfigSecret(current.connection_url_enc), connector);
  const enabled = input.enabled ?? current.enabled === 1;
  if (!enabled && current.is_default === 1)
    throw new Error("default schema source cannot be disabled");
  const semanticProfile =
    input.semanticProfile ??
    (isProfile(current.semantic_profile) ? current.semantic_profile : "generic");
  if (!isProfile(semanticProfile)) throw new Error("unknown semantic profile");
  openDb()
    .prepare(
      `UPDATE schema_sources SET name = ?, connector = ?, connection_url_enc = ?, database_name = ?, schema_name = ?, table_filter_json = ?, semantic_profile = ?, enabled = ?, updated_at = ? WHERE id = ?`,
    )
    .run(
      name,
      connector,
      input.connectionString?.trim()
        ? encryptConfigSecret(connectionString)
        : current.connection_url_enc,
      input.databaseName === undefined ? current.database_name : input.databaseName?.trim() || null,
      input.schemaName === undefined ? current.schema_name : input.schemaName?.trim() || null,
      input.tableFilter === undefined
        ? current.table_filter_json
        : JSON.stringify(normalizeFilters(input.tableFilter)),
      semanticProfile,
      enabled ? 1 : 0,
      now(),
      id,
    );
  return rowToSource(getRow(id)!) as SchemaSource;
}

export function setDefaultSchemaSource(id: string): SchemaSource | null {
  if (id === "environment-report") {
    if (!environmentSource()) return null;
    openDb().prepare(`UPDATE schema_sources SET is_default = 0 WHERE is_default = 1`).run();
    return withoutSecret(environmentSource()!);
  }
  const current = getRow(id);
  if (!current) return null;
  if (current.enabled !== 1) throw new Error("disabled schema source cannot be default");
  openDb()
    .prepare(
      `UPDATE schema_sources SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END, updated_at = ? WHERE is_default = 1 OR id = ?`,
    )
    .run(id, now(), id);
  return rowToSource(getRow(id)!) as SchemaSource;
}

export function deleteSchemaSource(id: string): "deleted" | "not_found" | "default" | "managed" {
  if (id === "environment-report") return "managed";
  const current = getRow(id);
  if (!current) return "not_found";
  if (current.is_default === 1) return "default";
  openDb().prepare(`DELETE FROM schema_sources WHERE id = ?`).run(id);
  return "deleted";
}

export function duplicateSchemaSource(id: string): SchemaSource | null {
  const source = getSchemaSource(id);
  if (!source) return null;
  return createSchemaSource({
    name: `${source.name} 副本`,
    connector: source.connector,
    connectionString: source.connectionString,
    databaseName: source.databaseName,
    schemaName: source.schemaName,
    tableFilter: source.tableFilter,
    semanticProfile: source.semanticProfile,
    enabled: false,
  });
}

export function updateSchemaSourceSyncState(
  id: string,
  patch: {
    status: SchemaSourceSyncStatus;
    lastSyncedAt?: string | null;
    error?: string | null;
    tableCount?: number;
    relationCount?: number;
  },
): void {
  if (id === "environment-report") {
    environmentSyncState.syncStatus = patch.status;
    if (patch.lastSyncedAt !== undefined) environmentSyncState.lastSyncedAt = patch.lastSyncedAt;
    if (patch.error !== undefined) environmentSyncState.lastError = patch.error;
    if (patch.tableCount !== undefined) environmentSyncState.tableCount = patch.tableCount;
    if (patch.relationCount !== undefined) environmentSyncState.relationCount = patch.relationCount;
    return;
  }
  openDb()
    .prepare(
      `UPDATE schema_sources
       SET sync_status = ?,
           last_synced_at = CASE WHEN ? = 1 THEN ? ELSE last_synced_at END,
           last_error = ?,
           table_count = COALESCE(?, table_count),
           relation_count = COALESCE(?, relation_count),
           updated_at = ?
       WHERE id = ?`,
    )
    .run(
      patch.status,
      patch.lastSyncedAt !== undefined ? 1 : 0,
      patch.lastSyncedAt ?? null,
      patch.error ?? null,
      patch.tableCount ?? null,
      patch.relationCount ?? null,
      now(),
      id,
    );
}

export async function probeSchemaSource(input: {
  connectionString: string;
  connector?: SchemaSourceConnector;
  databaseName?: string | null;
  schemaName?: string | null;
}): Promise<{ database: string; version: string }> {
  const connector =
    input.connector ?? connectorForConnectionString(input.connectionString) ?? "mysql";
  const connectionString = normalizeConnectionString(input.connectionString, connector);
  if (connector === "postgresql") {
    const pool = createPostgresPool(connectionString, {
      max: 1,
      connectionTimeoutMillis: 5_000,
      ...(input.databaseName?.trim() ? { database: input.databaseName.trim() } : {}),
    });
    try {
      const schema = input.schemaName?.trim() || "public";
      const result = await pool.pool.query<{
        database_name?: string;
        schema_exists?: boolean;
        version?: string;
      }>(
        `SELECT current_database() AS database_name,
                current_setting('server_version') AS version,
                EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS schema_exists`,
        [schema],
      );
      const row = result.rows[0];
      if (!row?.schema_exists) throw new Error(`PostgreSQL schema does not exist: ${schema}`);
      const database =
        input.databaseName?.trim() ||
        row.database_name ||
        new URL(connectionString).pathname.replace(/^\//, "");
      if (!database) throw new Error("database name is required");
      return { database, version: row.version ?? "unknown" };
    } finally {
      await pool.close();
    }
  }
  const pool = createMysqlPool(connectionString, {
    connectionLimit: 1,
    connectTimeout: 5_000,
    ...(input.databaseName?.trim() ? { database: input.databaseName.trim() } : {}),
  });
  try {
    const [rows] = await pool.pool.query(`SELECT DATABASE() AS databaseName, VERSION() AS version`);
    const row = (rows as Array<{ databaseName?: string; version?: string }>)[0];
    const database =
      input.databaseName?.trim() ||
      row?.databaseName ||
      new URL(connectionString).pathname.replace(/^\//, "");
    if (!database) throw new Error("database name is required");
    return { database, version: row?.version ?? "unknown" };
  } finally {
    await pool.close();
  }
}

export async function probeStoredSchemaSource(
  id: string,
): Promise<{ database: string; version: string }> {
  const source = getSchemaSource(id);
  if (!source) throw new Error("schema source not found");
  return probeSchemaSource(source);
}
