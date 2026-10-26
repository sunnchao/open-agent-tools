import { randomUUID } from "node:crypto";
import { normalizeStringList, parseJsonStringList } from "@open-agent-tools/api-contracts/values";
import { openDb } from "../../../platform/db.js";
import {
  MetricCaliberSchema,
  MetricStatusSchema,
  type MetricCaliber,
  type MetricCaliberInput,
  type MetricStatus,
} from "./caliber.js";

export interface MetricDefinition {
  id: string;
  name: string;
  description: string;
  category: string | null;
  unit: string | null;
  caliber: MetricCaliber;
  sourceId: string | null;
  tables: string[];
  synonyms: string[];
  tags: string[];
  status: MetricStatus;
  version: number;
  owner: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MetricDefinitionInput {
  id?: string;
  name: string;
  description?: string;
  category?: string | null;
  unit?: string | null;
  caliber: MetricCaliberInput;
  sourceId?: string | null;
  tables?: string[];
  synonyms?: string[];
  tags?: string[];
  status?: MetricStatus;
  owner?: string | null;
}

interface MetricDefinitionRow {
  id: string;
  name: string;
  description: string;
  category: string | null;
  unit: string | null;
  caliber_json: string;
  source_id: string | null;
  tables_json: string;
  synonyms_json: string;
  tags_json: string;
  status: string;
  version: number;
  owner: string | null;
  created_at: string;
  updated_at: string;
}

function now(): string {
  return new Date().toISOString();
}

function rowToMetric(row: MetricDefinitionRow): MetricDefinition {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    unit: row.unit,
    caliber: MetricCaliberSchema.parse(JSON.parse(row.caliber_json) as unknown),
    sourceId: row.source_id,
    tables: parseJsonStringList(row.tables_json),
    synonyms: parseJsonStringList(row.synonyms_json),
    tags: parseJsonStringList(row.tags_json),
    status: MetricStatusSchema.catch("active").parse(row.status),
    version: row.version,
    owner: row.owner,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getRow(id: string): MetricDefinitionRow | null {
  return (
    (openDb().prepare(`SELECT * FROM metric_definitions WHERE id = ?`).get(id) as
      MetricDefinitionRow | undefined) ?? null
  );
}

export function listMetricDefinitions(options?: {
  status?: MetricStatus;
  category?: string;
  sourceId?: string;
}): MetricDefinition[] {
  const conditions: string[] = [];
  const params: string[] = [];
  if (options?.status) {
    conditions.push("status = ?");
    params.push(options.status);
  }
  if (options?.category) {
    conditions.push("category = ?");
    params.push(options.category);
  }
  if (options?.sourceId) {
    conditions.push("source_id = ?");
    params.push(options.sourceId);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = openDb()
    .prepare(`SELECT * FROM metric_definitions ${where} ORDER BY category ASC, name ASC`)
    .all(...params) as unknown as MetricDefinitionRow[];
  return rows.map(rowToMetric);
}

export function getMetricDefinition(id: string): MetricDefinition | null {
  const row = getRow(id);
  return row ? rowToMetric(row) : null;
}

export function createMetricDefinition(input: MetricDefinitionInput): MetricDefinition {
  const name = input.name?.trim();
  if (!name) throw new Error("name is required");
  const caliber = MetricCaliberSchema.parse(input.caliber);
  const status = MetricStatusSchema.parse(input.status ?? "active");
  const id = input.id?.trim() || randomUUID();
  const timestamp = now();
  openDb()
    .prepare(
      `INSERT INTO metric_definitions
        (id, name, description, category, unit, caliber_json, source_id, tables_json, synonyms_json, tags_json, status, version, owner, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      id,
      name,
      input.description?.trim() ?? "",
      input.category?.trim() || null,
      input.unit?.trim() || null,
      JSON.stringify(caliber),
      input.sourceId?.trim() || null,
      JSON.stringify(normalizeStringList(input.tables)),
      JSON.stringify(normalizeStringList(input.synonyms)),
      JSON.stringify(normalizeStringList(input.tags)),
      status,
      input.owner?.trim() || null,
      timestamp,
      timestamp,
    );
  return rowToMetric(getRow(id)!);
}

export function updateMetricDefinition(
  id: string,
  input: Partial<MetricDefinitionInput>,
): MetricDefinition | null {
  const current = getRow(id);
  if (!current) return null;
  const name = input.name?.trim() || current.name;
  const caliber =
    input.caliber === undefined
      ? MetricCaliberSchema.parse(JSON.parse(current.caliber_json) as unknown)
      : MetricCaliberSchema.parse(input.caliber);
  const status =
    input.status === undefined
      ? rowToMetric(current).status
      : MetricStatusSchema.parse(input.status);
  openDb()
    .prepare(
      `UPDATE metric_definitions
       SET name = ?, description = ?, category = ?, unit = ?, caliber_json = ?, source_id = ?,
           tables_json = ?, synonyms_json = ?, tags_json = ?, status = ?, version = version + 1,
           owner = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      name,
      input.description === undefined ? current.description : input.description.trim(),
      input.category === undefined ? current.category : input.category?.trim() || null,
      input.unit === undefined ? current.unit : input.unit?.trim() || null,
      JSON.stringify(caliber),
      input.sourceId === undefined ? current.source_id : input.sourceId?.trim() || null,
      input.tables === undefined
        ? current.tables_json
        : JSON.stringify(normalizeStringList(input.tables)),
      input.synonyms === undefined
        ? current.synonyms_json
        : JSON.stringify(normalizeStringList(input.synonyms)),
      input.tags === undefined
        ? current.tags_json
        : JSON.stringify(normalizeStringList(input.tags)),
      status,
      input.owner === undefined ? current.owner : input.owner?.trim() || null,
      now(),
      id,
    );
  return rowToMetric(getRow(id)!);
}

export function deleteMetricDefinition(id: string): boolean {
  const result = openDb().prepare(`DELETE FROM metric_definitions WHERE id = ?`).run(id);
  return result.changes > 0;
}
