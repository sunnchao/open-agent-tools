import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../db.js";
import type {
  WorkflowApiKeyRecord,
  WorkflowApiKeyView,
  WorkflowApp,
  WorkflowDetail,
  WorkflowGraph,
  WorkflowRunEventRecord,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowVersion,
} from "./types.js";

type Row = Record<string, unknown>;

export class WorkflowNotFoundError extends Error {}
export class WorkflowConflictError extends Error {}

function now(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

function appFromRow(row: Row): WorkflowApp {
  return {
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    description: String(row.description ?? ""),
    status: row.status as WorkflowApp["status"],
    draftRevision: Number(row.draft_revision),
    currentVersionId: row.current_version_id ? String(row.current_version_id) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function versionFromRow(row: Row): WorkflowVersion {
  return {
    id: String(row.id),
    workflowId: String(row.workflow_id),
    versionNumber: Number(row.version_number),
    name: String(row.name),
    releaseNotes: String(row.release_notes ?? ""),
    graph: parseJson<WorkflowGraph>(row.graph_json),
    inputSchema: parseJson<Record<string, unknown>>(row.input_schema_json),
    outputSchema: parseJson<Record<string, unknown>>(row.output_schema_json),
    createdAt: String(row.created_at),
  };
}

function keyFromRow(row: Row): WorkflowApiKeyRecord {
  return {
    id: String(row.id),
    workflowId: String(row.workflow_id),
    name: String(row.name),
    keyHash: String(row.key_hash),
    prefix: String(row.prefix),
    status: row.status as WorkflowApiKeyRecord["status"],
    rateLimitPerMinute: Number(row.rate_limit_per_minute),
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    lastUsedAt: row.last_used_at ? String(row.last_used_at) : null,
    createdAt: String(row.created_at),
  };
}

function runFromRow(row: Row): WorkflowRunRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    workflowId: String(row.workflow_id),
    versionId: row.version_id ? String(row.version_id) : null,
    user: String(row.user_id),
    source: row.source as WorkflowRunRecord["source"],
    status: row.status as WorkflowRunStatus,
    inputs: parseJson<Record<string, unknown>>(row.inputs_json),
    outputs: row.outputs_json ? parseJson<Record<string, unknown>>(row.outputs_json) : null,
    error: row.error ? String(row.error) : null,
    totalSteps: Number(row.total_steps),
    totalTokens: Number(row.total_tokens),
    createdAt: String(row.created_at),
    finishedAt: row.finished_at ? String(row.finished_at) : null,
    elapsedTime: row.elapsed_time === null ? null : Number(row.elapsed_time),
  };
}

function database(): DatabaseSync {
  const db = openDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_apps (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'DELETED')) DEFAULT 'ACTIVE',
      draft_revision INTEGER NOT NULL DEFAULT 1,
      current_version_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_drafts (
      workflow_id TEXT PRIMARY KEY REFERENCES workflow_apps(id) ON DELETE CASCADE,
      graph_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_versions (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflow_apps(id) ON DELETE CASCADE,
      version_number INTEGER NOT NULL,
      name TEXT NOT NULL,
      release_notes TEXT NOT NULL DEFAULT '',
      graph_json TEXT NOT NULL,
      input_schema_json TEXT NOT NULL,
      output_schema_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(workflow_id, version_number)
    );

    CREATE TABLE IF NOT EXISTS workflow_api_keys (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflow_apps(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      prefix TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')) DEFAULT 'ACTIVE',
      rate_limit_per_minute INTEGER NOT NULL DEFAULT 60,
      expires_at TEXT,
      last_used_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL UNIQUE,
      workflow_id TEXT NOT NULL REFERENCES workflow_apps(id) ON DELETE RESTRICT,
      version_id TEXT REFERENCES workflow_versions(id) ON DELETE RESTRICT,
      user_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('service-api', 'studio')),
      status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'stopped')),
      inputs_json TEXT NOT NULL,
      outputs_json TEXT,
      error TEXT,
      total_steps INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      finished_at TEXT,
      elapsed_time REAL
    );

    CREATE TABLE IF NOT EXISTS workflow_node_runs (
      run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      status TEXT NOT NULL,
      inputs_json TEXT,
      outputs_json TEXT,
      error TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id, node_id)
    );

    CREATE TABLE IF NOT EXISTS workflow_events (
      run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, sequence)
    );

    CREATE TABLE IF NOT EXISTS workflow_audit_events (
      id TEXT PRIMARY KEY,
      workflow_id TEXT,
      action TEXT NOT NULL,
      target TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_idempotency (
      workflow_id TEXT NOT NULL REFERENCES workflow_apps(id) ON DELETE CASCADE,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      run_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (workflow_id, idempotency_key)
    );

    CREATE INDEX IF NOT EXISTS workflow_versions_app_idx
      ON workflow_versions(workflow_id, version_number DESC);
    CREATE INDEX IF NOT EXISTS workflow_keys_app_idx
      ON workflow_api_keys(workflow_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS workflow_runs_app_idx
      ON workflow_runs(workflow_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS workflow_events_run_idx
      ON workflow_events(run_id, sequence);
  `);
  const columns = db.prepare("PRAGMA table_info(workflow_runs)").all() as Row[];
  if (columns.some((column) => column.name === "version_id" && column.notnull === 1)) {
    // SQLite 不能直接移除 NOT NULL，重建父表时保留所有子表引用及历史数据。
    const schema = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'workflow_runs'")
      .get() as Row;
    db.exec("PRAGMA foreign_keys = OFF");
    try {
      transaction(db, () => {
        db.exec(
          String(schema.sql)
            .replace(
              /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`]?workflow_runs["`]?/i,
              "CREATE TABLE workflow_runs_nullable",
            )
            .replace(/version_id\s+TEXT\s+NOT NULL/i, "version_id TEXT"),
        );
        db.exec(`INSERT INTO workflow_runs_nullable SELECT * FROM workflow_runs;
          DROP TABLE workflow_runs;
          ALTER TABLE workflow_runs_nullable RENAME TO workflow_runs;
          CREATE INDEX workflow_runs_app_idx ON workflow_runs(workflow_id, created_at DESC);`);
        if (db.prepare("PRAGMA foreign_key_check").all().length) {
          throw new Error("workflow run migration violated foreign keys");
        }
      });
    } finally {
      db.exec("PRAGMA foreign_keys = ON");
    }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS workflow_run_snapshots (
    run_id TEXT PRIMARY KEY REFERENCES workflow_runs(id) ON DELETE CASCADE,
    graph_json TEXT NOT NULL
  )`);
  return db;
}

function transaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function normalizeSlug(name: string): string {
  const normalized = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || `workflow-${Date.now().toString(36)}`;
}

function uniqueSlug(db: DatabaseSync, name: string): string {
  const base = normalizeSlug(name);
  let slug = base;
  let suffix = 2;
  while (db.prepare("SELECT 1 FROM workflow_apps WHERE slug = ?").get(slug)) {
    slug = `${base.slice(0, 43)}-${suffix}`;
    suffix += 1;
  }
  return slug;
}

export function createDefaultWorkflowGraph(name: string): WorkflowGraph {
  return {
    name,
    nodes: [
      {
        id: "start-1",
        type: "studio",
        position: { x: 80, y: 240 },
        data: {
          id: "start-1",
          kind: "start",
          label: "开始",
          description: "工作流入口",
          status: "idle",
          config: {
            inputs: [],
            outputs: [],
            runVariables: [{ name: "query", type: "string", required: true }],
          },
        },
      },
      {
        id: "input-1",
        type: "studio",
        position: { x: 360, y: 240 },
        data: {
          id: "input-1",
          kind: "input",
          label: "用户输入",
          description: "定义输入变量",
          status: "idle",
          config: {
            inputs: [{ name: "query", source: { type: "run", variable: "query" }, required: true }],
            outputs: [{ name: "query", selector: "$inputs.query" }],
          },
        },
      },
      {
        id: "end-1",
        type: "studio",
        position: { x: 640, y: 240 },
        data: {
          id: "end-1",
          kind: "end",
          label: "结束",
          description: "定义最终输出",
          status: "idle",
          config: {
            inputs: [
              {
                name: "result",
                source: { type: "node", nodeId: "input-1", output: "query" },
                required: true,
              },
            ],
            outputs: [{ name: "result", selector: "$inputs.result" }],
          },
        },
      },
    ],
    edges: [
      { id: "edge-start-input", source: "start-1", target: "input-1" },
      { id: "edge-input-end", source: "input-1", target: "end-1" },
    ],
  };
}

export function createWorkflow(input: {
  name: string;
  description?: string;
  graph?: WorkflowGraph;
}): WorkflowDetail {
  const db = database();
  const id = randomUUID();
  const createdAt = now();
  const name = input.name.trim() || "未命名工作流";
  const graph = input.graph ?? createDefaultWorkflowGraph(name);
  const slug = uniqueSlug(db, name);
  transaction(db, () => {
    db.prepare(
      `INSERT INTO workflow_apps
        (id, name, slug, description, status, draft_revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'ACTIVE', 1, ?, ?)`,
    ).run(id, name, slug, input.description?.trim() ?? "", createdAt, createdAt);
    db.prepare(
      `INSERT INTO workflow_drafts (workflow_id, graph_json, updated_at) VALUES (?, ?, ?)`,
    ).run(id, JSON.stringify({ ...graph, name }), createdAt);
    audit(db, id, "workflow.created", id, { slug });
  });
  return getWorkflow(id)!;
}

export function listWorkflows(): WorkflowApp[] {
  return (
    database()
      .prepare(
        `SELECT * FROM workflow_apps WHERE status = 'ACTIVE' ORDER BY updated_at DESC, name ASC`,
      )
      .all() as Row[]
  ).map(appFromRow);
}

export function getWorkflow(workflowId: string): WorkflowDetail | null {
  const db = database();
  const row = db
    .prepare(`SELECT * FROM workflow_apps WHERE id = ? AND status = 'ACTIVE'`)
    .get(workflowId) as Row | undefined;
  if (!row) return null;
  const draft = db
    .prepare(`SELECT graph_json FROM workflow_drafts WHERE workflow_id = ?`)
    .get(workflowId) as Row | undefined;
  return {
    app: appFromRow(row),
    draft: parseJson<WorkflowGraph>(draft?.graph_json),
    versions: listWorkflowVersions(workflowId),
  };
}

export function getWorkflowBySlug(slug: string): WorkflowApp | null {
  const row = database()
    .prepare(`SELECT * FROM workflow_apps WHERE slug = ? AND status = 'ACTIVE'`)
    .get(slug) as Row | undefined;
  return row ? appFromRow(row) : null;
}

export function saveWorkflowDraft(
  workflowId: string,
  expectedRevision: number,
  graph: WorkflowGraph,
): WorkflowDetail {
  const db = database();
  return transaction(db, () => {
    const current = db
      .prepare(`SELECT * FROM workflow_apps WHERE id = ? AND status = 'ACTIVE'`)
      .get(workflowId) as Row | undefined;
    if (!current) throw new WorkflowNotFoundError("workflow not found");
    if (Number(current.draft_revision) !== expectedRevision) {
      throw new WorkflowConflictError("workflow draft changed; reload before saving");
    }
    const updatedAt = now();
    const result = db
      .prepare(
        `UPDATE workflow_apps
         SET name = ?, draft_revision = draft_revision + 1, updated_at = ?
         WHERE id = ? AND draft_revision = ?`,
      )
      .run(graph.name.trim() || String(current.name), updatedAt, workflowId, expectedRevision);
    if (result.changes !== 1) throw new WorkflowConflictError("workflow draft changed");
    db.prepare(
      `UPDATE workflow_drafts SET graph_json = ?, updated_at = ? WHERE workflow_id = ?`,
    ).run(JSON.stringify(graph), updatedAt, workflowId);
    audit(db, workflowId, "workflow.draft.saved", workflowId, {
      revision: expectedRevision + 1,
    });
    return getWorkflow(workflowId)!;
  });
}

export function listWorkflowVersions(workflowId: string): WorkflowVersion[] {
  return (
    database()
      .prepare(`SELECT * FROM workflow_versions WHERE workflow_id = ? ORDER BY version_number DESC`)
      .all(workflowId) as Row[]
  ).map(versionFromRow);
}

export function getWorkflowVersion(versionId: string): WorkflowVersion | null {
  const row = database().prepare(`SELECT * FROM workflow_versions WHERE id = ?`).get(versionId) as
    Row | undefined;
  return row ? versionFromRow(row) : null;
}

export function publishWorkflow(input: {
  workflowId: string;
  expectedRevision: number;
  releaseNotes?: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}): WorkflowVersion {
  const db = database();
  return transaction(db, () => {
    const detail = getWorkflow(input.workflowId);
    if (!detail) throw new WorkflowNotFoundError("workflow not found");
    if (detail.app.draftRevision !== input.expectedRevision) {
      throw new WorkflowConflictError("workflow draft changed; reload before publishing");
    }
    const next = Number(
      (
        db
          .prepare(
            `SELECT COALESCE(MAX(version_number), 0) + 1 AS version_number
           FROM workflow_versions WHERE workflow_id = ?`,
          )
          .get(input.workflowId) as Row
      ).version_number,
    );
    const id = randomUUID();
    const createdAt = now();
    db.prepare(
      `INSERT INTO workflow_versions
        (id, workflow_id, version_number, name, release_notes, graph_json,
         input_schema_json, output_schema_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.workflowId,
      next,
      `v${next}`,
      input.releaseNotes?.trim() ?? "",
      JSON.stringify(detail.draft),
      JSON.stringify(input.inputSchema),
      JSON.stringify(input.outputSchema),
      createdAt,
    );
    db.prepare(`UPDATE workflow_apps SET current_version_id = ?, updated_at = ? WHERE id = ?`).run(
      id,
      createdAt,
      input.workflowId,
    );
    audit(db, input.workflowId, "workflow.published", id, { versionNumber: next });
    return getWorkflowVersion(id)!;
  });
}

export function rollbackWorkflow(workflowId: string, versionId: string): WorkflowDetail {
  const db = database();
  return transaction(db, () => {
    const version = getWorkflowVersion(versionId);
    if (!version || version.workflowId !== workflowId) {
      throw new WorkflowNotFoundError("workflow version not found");
    }
    db.prepare(`UPDATE workflow_apps SET current_version_id = ?, updated_at = ? WHERE id = ?`).run(
      versionId,
      now(),
      workflowId,
    );
    audit(db, workflowId, "workflow.rolled_back", versionId, {
      versionNumber: version.versionNumber,
    });
    return getWorkflow(workflowId)!;
  });
}

export function duplicateWorkflow(workflowId: string): WorkflowDetail {
  const source = getWorkflow(workflowId);
  if (!source) throw new WorkflowNotFoundError("workflow not found");
  return createWorkflow({
    name: `${source.app.name} 副本`,
    description: source.app.description,
    graph: { ...structuredClone(source.draft), name: `${source.app.name} 副本` },
  });
}

export function deleteWorkflow(workflowId: string): boolean {
  const db = database();
  const result = db
    .prepare(`UPDATE workflow_apps SET status = 'DELETED', updated_at = ? WHERE id = ?`)
    .run(now(), workflowId);
  if (result.changes === 1) audit(db, workflowId, "workflow.deleted", workflowId, {});
  return result.changes === 1;
}

export function insertWorkflowApiKey(record: WorkflowApiKeyRecord): WorkflowApiKeyView {
  const db = database();
  db.prepare(
    `INSERT INTO workflow_api_keys
      (id, workflow_id, name, key_hash, prefix, status, rate_limit_per_minute,
       expires_at, last_used_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.workflowId,
    record.name,
    record.keyHash,
    record.prefix,
    record.status,
    record.rateLimitPerMinute,
    record.expiresAt,
    record.lastUsedAt,
    record.createdAt,
  );
  audit(db, record.workflowId, "workflow.key.created", record.id, { prefix: record.prefix });
  const { keyHash: _keyHash, ...view } = record;
  return view;
}

export function getWorkflowApiKey(keyId: string): WorkflowApiKeyRecord | null {
  const row = database().prepare(`SELECT * FROM workflow_api_keys WHERE id = ?`).get(keyId) as
    Row | undefined;
  return row ? keyFromRow(row) : null;
}

export function listWorkflowApiKeys(workflowId: string): WorkflowApiKeyView[] {
  return (
    database()
      .prepare(`SELECT * FROM workflow_api_keys WHERE workflow_id = ? ORDER BY created_at DESC`)
      .all(workflowId) as Row[]
  ).map((row) => {
    const { keyHash: _keyHash, ...view } = keyFromRow(row);
    return view;
  });
}

export function touchWorkflowApiKey(keyId: string): void {
  database()
    .prepare(`UPDATE workflow_api_keys SET last_used_at = ? WHERE id = ?`)
    .run(now(), keyId);
}

export function revokeWorkflowApiKey(workflowId: string, keyId: string): boolean {
  const db = database();
  const result = db
    .prepare(
      `UPDATE workflow_api_keys SET status = 'REVOKED'
       WHERE id = ? AND workflow_id = ? AND status = 'ACTIVE'`,
    )
    .run(keyId, workflowId);
  if (result.changes === 1) audit(db, workflowId, "workflow.key.revoked", keyId, {});
  return result.changes === 1;
}

export function createWorkflowRun(record: WorkflowRunRecord, graph?: WorkflowGraph): void {
  const db = database();
  transaction(db, () => {
    const app = db
      .prepare("SELECT id FROM workflow_apps WHERE id = ? AND status = 'ACTIVE'")
      .get(record.workflowId);
    if (!app) throw new WorkflowNotFoundError("workflow not found");
    if (record.versionId) {
      const version = db
        .prepare("SELECT id FROM workflow_versions WHERE id = ? AND workflow_id = ?")
        .get(record.versionId, record.workflowId);
      if (!version) throw new WorkflowNotFoundError("workflow version not found");
    }
    db.prepare(
      `INSERT INTO workflow_runs
        (id, task_id, workflow_id, version_id, user_id, source, status, inputs_json,
         outputs_json, error, total_steps, total_tokens, created_at, finished_at, elapsed_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.id,
      record.taskId,
      record.workflowId,
      record.versionId,
      record.user,
      record.source,
      record.status,
      JSON.stringify(record.inputs),
      record.outputs ? JSON.stringify(record.outputs) : null,
      record.error,
      record.totalSteps,
      record.totalTokens,
      record.createdAt,
      record.finishedAt,
      record.elapsedTime,
    );
    if (graph) {
      db.prepare("INSERT INTO workflow_run_snapshots (run_id, graph_json) VALUES (?, ?)").run(
        record.id,
        JSON.stringify(structuredClone(graph)),
      );
    }
  });
}

export function getWorkflowRunSnapshot(runId: string): WorkflowGraph | null {
  const row = database()
    .prepare("SELECT graph_json FROM workflow_run_snapshots WHERE run_id = ?")
    .get(runId) as Row | undefined;
  return row ? parseJson<WorkflowGraph>(row.graph_json) : null;
}

export function finishWorkflowRun(input: {
  runId: string;
  status: Exclude<WorkflowRunStatus, "running">;
  outputs?: Record<string, unknown>;
  error?: string;
  totalSteps: number;
  totalTokens: number;
  elapsedTime: number;
}): void {
  database()
    .prepare(
      `UPDATE workflow_runs
       SET status = ?, outputs_json = ?, error = ?, total_steps = ?, total_tokens = ?,
           finished_at = ?, elapsed_time = ?
       WHERE id = ?`,
    )
    .run(
      input.status,
      input.outputs ? JSON.stringify(input.outputs) : null,
      input.error ?? null,
      input.totalSteps,
      input.totalTokens,
      now(),
      input.elapsedTime,
      input.runId,
    );
}

export function getWorkflowRun(runId: string): WorkflowRunRecord | null {
  const row = database().prepare(`SELECT * FROM workflow_runs WHERE id = ?`).get(runId) as
    Row | undefined;
  return row ? runFromRow(row) : null;
}

export function getWorkflowRunByTask(taskId: string): WorkflowRunRecord | null {
  const row = database().prepare(`SELECT * FROM workflow_runs WHERE task_id = ?`).get(taskId) as
    Row | undefined;
  return row ? runFromRow(row) : null;
}

export function listWorkflowRuns(workflowId: string, limit = 50): WorkflowRunRecord[] {
  return (
    database()
      .prepare(`SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(workflowId, Math.max(1, Math.min(100, limit))) as Row[]
  ).map(runFromRow);
}

export function appendWorkflowEvent(
  runId: string,
  type: string,
  payload: Record<string, unknown>,
): WorkflowRunEventRecord {
  const db = database();
  return transaction(db, () => {
    const sequence = Number(
      (
        db
          .prepare(
            `SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM workflow_events WHERE run_id = ?`,
          )
          .get(runId) as Row
      ).sequence,
    );
    const createdAt = now();
    db.prepare(
      `INSERT INTO workflow_events (run_id, sequence, type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(runId, sequence, type, JSON.stringify(payload), createdAt);
    return { runId, sequence, type, payload, createdAt };
  });
}

export function listWorkflowEvents(runId: string, after = 0): WorkflowRunEventRecord[] {
  const rows = database()
    .prepare(
      `SELECT * FROM workflow_events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC`,
    )
    .all(runId, Math.max(0, after)) as Row[];
  return rows.map((row) => ({
    runId: String(row.run_id),
    sequence: Number(row.sequence),
    type: String(row.type),
    payload: parseJson<Record<string, unknown>>(row.payload_json),
    createdAt: String(row.created_at),
  }));
}

export function upsertWorkflowNodeRun(input: {
  runId: string;
  nodeId: string;
  status: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  error?: string;
  durationMs?: number;
  totalTokens?: number;
}): void {
  database()
    .prepare(
      `INSERT INTO workflow_node_runs
        (run_id, node_id, status, inputs_json, outputs_json, error, duration_ms, total_tokens, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, node_id) DO UPDATE SET
         status = excluded.status,
         inputs_json = excluded.inputs_json,
         outputs_json = excluded.outputs_json,
         error = excluded.error,
         duration_ms = excluded.duration_ms,
         total_tokens = excluded.total_tokens,
         updated_at = excluded.updated_at`,
    )
    .run(
      input.runId,
      input.nodeId,
      input.status,
      input.inputs ? JSON.stringify(input.inputs) : null,
      input.outputs ? JSON.stringify(input.outputs) : null,
      input.error ?? null,
      input.durationMs ?? 0,
      input.totalTokens ?? 0,
      now(),
    );
}

export function claimWorkflowIdempotency(input: {
  workflowId: string;
  idempotencyKey: string;
  requestHash: string;
  runId: string;
}): { claimed: true; runId: string } | { claimed: false; runId: string; requestHash: string } {
  const db = database();
  return transaction(db, () => {
    const existing = db
      .prepare(
        `SELECT request_hash, run_id FROM workflow_idempotency
         WHERE workflow_id = ? AND idempotency_key = ?`,
      )
      .get(input.workflowId, input.idempotencyKey) as Row | undefined;
    if (existing) {
      return {
        claimed: false,
        runId: String(existing.run_id),
        requestHash: String(existing.request_hash),
      };
    }
    db.prepare(
      `INSERT INTO workflow_idempotency
        (workflow_id, idempotency_key, request_hash, run_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(input.workflowId, input.idempotencyKey, input.requestHash, input.runId, now());
    return { claimed: true, runId: input.runId };
  });
}

function audit(
  db: DatabaseSync,
  workflowId: string | null,
  action: string,
  target: string,
  metadata: Record<string, unknown>,
): void {
  db.prepare(
    `INSERT INTO workflow_audit_events
      (id, workflow_id, action, target, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), workflowId, action, target, JSON.stringify(metadata), now());
}
