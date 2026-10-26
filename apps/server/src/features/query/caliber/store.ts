import { randomUUID } from "node:crypto";
import { CaliberConfigSchema, type CaliberConfig, type CaliberConfigInput } from "@open-agent-tools/query-resolver";
import { openDb } from "../../../platform/db.js";

export interface CaliberConfigRecord {
  id: string;
  name: string;
  description: string;
  config: CaliberConfig;
  isDefault: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CaliberConfigRecordInput {
  id?: string;
  name: string;
  description?: string;
  config: CaliberConfigInput;
  enabled?: boolean;
  isDefault?: boolean;
}

interface CaliberConfigRow {
  id: string;
  name: string;
  description: string;
  config_json: string;
  is_default: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function now(): string {
  return new Date().toISOString();
}

function rowToRecord(row: CaliberConfigRow): CaliberConfigRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    // 存量配置可能在 schema 演进后缺字段，parse 时用默认值补齐。
    config: CaliberConfigSchema.parse(JSON.parse(row.config_json) as unknown),
    isDefault: row.is_default === 1,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getRow(id: string): CaliberConfigRow | null {
  return (
    (openDb().prepare(`SELECT * FROM caliber_configs WHERE id = ?`).get(id) as
      | CaliberConfigRow
      | undefined) ?? null
  );
}

export function listCaliberConfigs(options?: { includeDisabled?: boolean }): CaliberConfigRecord[] {
  const rows = openDb()
    .prepare(
      `SELECT * FROM caliber_configs ${options?.includeDisabled ? "" : "WHERE enabled = 1"}
       ORDER BY is_default DESC, name ASC`,
    )
    .all() as unknown as CaliberConfigRow[];
  return rows.map(rowToRecord);
}

export function getCaliberConfig(id: string): CaliberConfigRecord | null {
  const row = getRow(id);
  return row ? rowToRecord(row) : null;
}

export function getDefaultCaliberConfig(options?: {
  requireEnabled?: boolean;
}): CaliberConfigRecord | null {
  const row = openDb()
    .prepare(
      `SELECT * FROM caliber_configs WHERE is_default = 1 ${options?.requireEnabled ? "AND enabled = 1" : ""} LIMIT 1`,
    )
    .get() as CaliberConfigRow | undefined;
  return row ? rowToRecord(row) : null;
}

export function createCaliberConfig(input: CaliberConfigRecordInput): CaliberConfigRecord {
  const name = input.name?.trim();
  if (!name) throw new Error("name is required");
  const config = CaliberConfigSchema.parse(input.config);
  const id = input.id?.trim() || randomUUID();
  const timestamp = now();
  const enabled = input.enabled !== false;
  const shouldDefault = input.isDefault === true || !getDefaultCaliberConfig();
  openDb()
    .prepare(
      `INSERT INTO caliber_configs (id, name, description, config_json, is_default, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      name,
      input.description?.trim() ?? "",
      JSON.stringify(config),
      shouldDefault && enabled ? 1 : 0,
      enabled ? 1 : 0,
      timestamp,
      timestamp,
    );
  return rowToRecord(getRow(id)!);
}

export function updateCaliberConfig(
  id: string,
  input: Partial<Omit<CaliberConfigRecordInput, "id">>,
): CaliberConfigRecord | null {
  const current = getRow(id);
  if (!current) return null;
  const config =
    input.config === undefined
      ? CaliberConfigSchema.parse(JSON.parse(current.config_json) as unknown)
      : CaliberConfigSchema.parse(input.config);
  const enabled = input.enabled ?? current.enabled === 1;
  if (!enabled && current.is_default === 1) {
    throw new Error("default caliber config cannot be disabled");
  }
  openDb()
    .prepare(
      `UPDATE caliber_configs
       SET name = ?, description = ?, config_json = ?, enabled = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      input.name?.trim() || current.name,
      input.description === undefined ? current.description : input.description.trim(),
      JSON.stringify(config),
      enabled ? 1 : 0,
      now(),
      id,
    );
  return rowToRecord(getRow(id)!);
}

export function setDefaultCaliberConfig(id: string): CaliberConfigRecord | null {
  const current = getRow(id);
  if (!current) return null;
  if (current.enabled !== 1) throw new Error("disabled caliber config cannot be default");
  openDb()
    .prepare(
      `UPDATE caliber_configs SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END, updated_at = ?
       WHERE is_default = 1 OR id = ?`,
    )
    .run(id, now(), id);
  return rowToRecord(getRow(id)!);
}

export function deleteCaliberConfig(id: string): "deleted" | "not_found" | "default" {
  const current = getRow(id);
  if (!current) return "not_found";
  if (current.is_default === 1) return "default";
  openDb().prepare(`DELETE FROM caliber_configs WHERE id = ?`).run(id);
  return "deleted";
}
