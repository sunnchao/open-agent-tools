import { auditFilterClause } from "./queryAuditFilter.js";
import { createHash, randomUUID } from "node:crypto";
import { redactAuditPayload } from "@open-agent-tools/observability/audit";
import type { Clarification } from "@open-agent-tools/query-resolver";
import { openDb } from "../db.js";
import type { HistoryTurn } from "../oneapiDemo/text2sql.js";
import type { detectRowLimitIntent } from "../schema-inject.js";
import { DEFAULT_WORKSPACE_ID } from "../workspace.js";
import type { UsageSnapshot } from "../usageTracking.js";

export const QUERY_STEPS = [
  { id: "source", label: "解析数据源" },
  { id: "schema", label: "加载 Schema" },
  { id: "retrieval", label: "检索相关表" },
  { id: "generation", label: "生成 SQL" },
  { id: "validation", label: "校验 SQL" },
  { id: "execution", label: "执行查询" },
  { id: "output", label: "输出结果" },
] as const;

export type QueryStepId = (typeof QUERY_STEPS)[number]["id"];
export type QueryStepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";
export type QueryAuditStatus = "running" | "succeeded" | "failed" | "clarifying";
export type QueryEntrypoint = "observatory" | "chat" | "workflow" | "rerun" | "unknown";
export type QueryAuditSource = "generated" | "rerun" | "workflow" | "chat" | "clarification";
export type QuerySqlSource = "generated" | "edited" | "original";

export interface QueryStep {
  id: QueryStepId;
  label: string;
  status: QueryStepStatus;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  message?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
}

export interface QueryAuditSummary {
  id: string;
  sourceId: string | null;
  sourceName: string | null;
  question: string;
  status: QueryAuditStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number;
  rowCount: number | null;
  error: string | null;
  actor: string;
  /** 旧记录没有该字段时由读取层归一为 legacy。 */
  actorType?: "operator" | "legacy";
  entrypoint: QueryEntrypoint;
  source: QueryAuditSource;
  sqlSource: QuerySqlSource;
  parentAuditId: string | null;
  /** 子链路重跑时允许列表直接带出可再次编辑的 SQL；普通列表保持摘要体积。 */
  generatedSql?: string | null;
  executedSql?: string | null;
  workspace: string;
}

export interface QueryAuditRecord extends QueryAuditSummary {
  usage?: UsageSnapshot;
  rowLimit?: ReturnType<typeof detectRowLimitIntent>;
  history: HistoryTurn[];
  steps: QueryStep[];
  selectedTables: string[];
  sql: string | null;
  originalQuestion: string;
  generatedSql: string | null;
  executedSql: string | null;
  clarification: Clarification | null;
  clarifying: string | null;
  providerId: string | null;
  model: string | null;
  resultPreview: Record<string, unknown>[];
}

export interface QueryAuditCreateOptions {
  actor?: string;
  entrypoint?: QueryEntrypoint;
  source?: QueryAuditSource;
  sqlSource?: QuerySqlSource;
  parentAuditId?: string | null;
  workspace?: string;
  originalQuestion?: string;
  clarification?: Clarification | null;
  generatedSql?: string | null;
  executedSql?: string | null;
}

export interface QueryAuditDetail {
  record: QueryAuditRecord;
  parent: QueryAuditSummary | null;
  children: QueryAuditSummary[];
}

export type QueryProgressEvent =
  | { type: "start"; auditId: string; steps: QueryStep[] }
  | { type: "step"; auditId: string; step: QueryStep }
  | {
      type: "clarification";
      auditId: string;
      clarification: Clarification;
    };

export interface QueryAuditFilters {
  sourceId?: string;
  status?: QueryAuditStatus;
  actor?: string;
  entrypoint?: QueryEntrypoint;
  source?: QueryAuditSource;
  sqlSource?: QuerySqlSource;
  parentAuditId?: string;
  workspace?: string;
  from?: string;
  to?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

const DEFAULT_ACTOR = "operator:deployment";

export function operatorActorForToken(token: string | null | undefined): string {
  const trimmed = token?.replace(/^Bearer\s+/i, "").trim();
  return trimmed
    ? `operator-token:${createHash("sha256").update(trimmed).digest("hex").slice(0, 16)}`
    : DEFAULT_ACTOR;
}

function database() {
  const db = openDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS observatory_query_audits (
      id TEXT PRIMARY KEY,
      source_id TEXT,
      status TEXT NOT NULL,
      question TEXT NOT NULL,
      started_at TEXT NOT NULL,
      record_json TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'operator:deployment',
      actor_type TEXT NOT NULL DEFAULT 'legacy',
      entrypoint TEXT NOT NULL DEFAULT 'unknown',
      source TEXT NOT NULL DEFAULT 'generated',
      sql_source TEXT NOT NULL DEFAULT 'generated',
      parent_audit_id TEXT,
      workspace TEXT NOT NULL DEFAULT 'default',
      original_question TEXT NOT NULL DEFAULT '',
      generated_sql TEXT,
      executed_sql TEXT,
      clarification_json TEXT,
      finished_at TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      row_count INTEGER,
      error TEXT
    );
  `);
  migrateQueryAuditColumns(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_observatory_audits_source_started
      ON observatory_query_audits(source_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_observatory_audits_started
      ON observatory_query_audits(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_observatory_audits_actor_started
      ON observatory_query_audits(actor, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_observatory_audits_entrypoint_started
      ON observatory_query_audits(entrypoint, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_observatory_audits_parent
      ON observatory_query_audits(parent_audit_id);
    CREATE INDEX IF NOT EXISTS idx_observatory_audits_workspace_started
      ON observatory_query_audits(workspace, started_at DESC);
  `);
  return db;
}

/** 老库只加列，不重建；历史记录按“legacy operator”解释。 */
function migrateQueryAuditColumns(db: ReturnType<typeof openDb>): void {
  const columns = new Set(
    (
      db.prepare(`PRAGMA table_info(observatory_query_audits)`).all() as Array<{ name: string }>
    ).map((row) => row.name),
  );
  const additions = [
    ["actor", `TEXT NOT NULL DEFAULT '${DEFAULT_ACTOR}'`],
    ["actor_type", "TEXT NOT NULL DEFAULT 'legacy'"],
    ["entrypoint", "TEXT NOT NULL DEFAULT 'unknown'"],
    ["source", "TEXT NOT NULL DEFAULT 'generated'"],
    ["sql_source", "TEXT NOT NULL DEFAULT 'generated'"],
    ["parent_audit_id", "TEXT"],
    ["workspace", `TEXT NOT NULL DEFAULT '${DEFAULT_WORKSPACE_ID}'`],
    ["original_question", "TEXT NOT NULL DEFAULT ''"],
    ["generated_sql", "TEXT"],
    ["executed_sql", "TEXT"],
    ["clarification_json", "TEXT"],
    ["finished_at", "TEXT"],
    ["duration_ms", "INTEGER NOT NULL DEFAULT 0"],
    ["row_count", "INTEGER"],
    ["error", "TEXT"],
  ] as const;
  for (const [name, definition] of additions) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE observatory_query_audits ADD COLUMN ${name} ${definition}`);
    }
  }
}

function toSummary(record: QueryAuditRecord): QueryAuditSummary {
  return {
    id: record.id,
    sourceId: record.sourceId,
    sourceName: record.sourceName,
    question: record.question,
    status: record.status,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    durationMs:
      record.status === "running"
        ? Math.max(0, Date.now() - Date.parse(record.startedAt))
        : record.durationMs,
    rowCount: record.rowCount,
    error: record.error,
    actor: record.actor,
    actorType: record.actorType,
    entrypoint: record.entrypoint,
    source: record.source,
    sqlSource: record.sqlSource,
    parentAuditId: record.parentAuditId,
    ...(record.source === "rerun"
      ? { generatedSql: record.generatedSql, executedSql: record.executedSql }
      : {}),
    workspace: record.workspace,
  };
}

function normalizeRecord(value: Record<string, unknown>): QueryAuditRecord {
  const record = value as unknown as QueryAuditRecord;
  const rawQuestion = typeof record.question === "string" ? record.question : "";
  const question = record.originalQuestion || rawQuestion;
  return {
    ...record,
    question: rawQuestion || question,
    actor: record.actor || DEFAULT_ACTOR,
    actorType: record.actorType || "legacy",
    entrypoint: record.entrypoint || "unknown",
    source: record.source || "generated",
    sqlSource: record.sqlSource || "generated",
    parentAuditId: record.parentAuditId ?? null,
    workspace: record.workspace || DEFAULT_WORKSPACE_ID,
    originalQuestion: question,
    generatedSql: record.generatedSql ?? record.sql ?? null,
    executedSql: record.executedSql ?? record.sql ?? null,
    clarification: record.clarification ?? null,
    clarifying: record.clarifying ?? null,
    history: Array.isArray(record.history) ? record.history : [],
    steps: Array.isArray(record.steps) ? record.steps : [],
    selectedTables: Array.isArray(record.selectedTables) ? record.selectedTables : [],
    resultPreview: Array.isArray(record.resultPreview) ? record.resultPreview : [],
  };
}

export function listQueryAudits(filters: QueryAuditFilters): {
  records: QueryAuditSummary[];
  total: number;
} {
  const { conditions, params } = auditFilterClause(filters);
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const db = database();
  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM observatory_query_audits ${where}`)
    .get(...params) as { total: number };
  const rows = db
    .prepare(
      `SELECT record_json FROM observatory_query_audits ${where}
       ORDER BY started_at DESC, rowid DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, filters.limit ?? 20, filters.offset ?? 0) as { record_json: string }[];
  return {
    records: rows.map((row) =>
      toSummary(normalizeRecord(JSON.parse(row.record_json) as Record<string, unknown>)),
    ),
    total,
  };
}

export function getQueryAudit(id: string): QueryAuditRecord | null {
  const row = database()
    .prepare("SELECT record_json FROM observatory_query_audits WHERE id = ?")
    .get(id) as { record_json: string } | undefined;
  if (!row) return null;
  const record = normalizeRecord(JSON.parse(row.record_json) as Record<string, unknown>);
  if (record.status === "running") {
    record.durationMs = Math.max(0, Date.now() - Date.parse(record.startedAt));
  }
  return record;
}

/** C5 详情视图：返回不可变记录及其直接父子链（仍按调用方 workspace 过滤）。 */
export function getQueryAuditDetail(id: string, workspace: string): QueryAuditDetail | null {
  const record = getQueryAudit(id);
  if (!record || record.workspace !== workspace) return null;
  const parent = record.parentAuditId ? getQueryAudit(record.parentAuditId) : null;
  const visibleParent = parent && parent.workspace === workspace ? toSummary(parent) : null;
  const { records: children } = listQueryAudits({
    parentAuditId: record.id,
    workspace,
    limit: 20,
  });
  return { record, parent: visibleParent, children };
}

export function createQueryAudit(
  sourceId: string | undefined,
  question: string,
  history: HistoryTurn[],
  onProgress?: (event: QueryProgressEvent) => void,
  options: QueryAuditCreateOptions = {},
) {
  const started = Date.now();
  const secrets = new Set<string>();
  const actor = options.actor?.trim() || DEFAULT_ACTOR;
  const record: QueryAuditRecord = {
    id: randomUUID(),
    sourceId: sourceId ?? null,
    sourceName: null,
    question,
    history,
    status: "running",
    startedAt: new Date(started).toISOString(),
    finishedAt: null,
    durationMs: 0,
    rowCount: null,
    error: null,
    actor,
    actorType: "operator",
    entrypoint: options.entrypoint ?? "unknown",
    source: options.source ?? "generated",
    sqlSource: options.sqlSource ?? "generated",
    parentAuditId: options.parentAuditId ?? null,
    workspace: options.workspace?.trim() || DEFAULT_WORKSPACE_ID,
    steps: QUERY_STEPS.map((step) => ({ ...step, status: "pending" })),
    selectedTables: [],
    sql: options.generatedSql ?? options.executedSql ?? null,
    originalQuestion: options.originalQuestion ?? question,
    generatedSql: options.generatedSql ?? null,
    executedSql: options.executedSql ?? null,
    clarification: options.clarification ?? null,
    clarifying: null,
    providerId: null,
    model: null,
    resultPreview: [],
  };
  const clean = <T>(value: T): T => redactAuditPayload(value, secrets) as T;
  const save = () => {
    record.durationMs = Date.now() - started;
    const snapshot = clean(record);
    database()
      .prepare(
        `INSERT INTO observatory_query_audits
          (id, source_id, status, question, started_at, record_json, actor, actor_type,
           entrypoint, source, sql_source, parent_audit_id, workspace, original_question,
           generated_sql, executed_sql, clarification_json, finished_at, duration_ms, row_count, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           source_id=excluded.source_id, status=excluded.status, question=excluded.question,
           record_json=excluded.record_json, actor=excluded.actor, actor_type=excluded.actor_type,
           entrypoint=excluded.entrypoint, source=excluded.source, sql_source=excluded.sql_source,
           parent_audit_id=excluded.parent_audit_id, workspace=excluded.workspace,
           original_question=excluded.original_question, generated_sql=excluded.generated_sql,
           executed_sql=excluded.executed_sql, clarification_json=excluded.clarification_json,
           finished_at=excluded.finished_at, duration_ms=excluded.duration_ms,
           row_count=excluded.row_count, error=excluded.error`,
      )
      .run(
        record.id,
        record.sourceId,
        record.status,
        snapshot.question,
        record.startedAt,
        JSON.stringify(snapshot),
        snapshot.actor,
        snapshot.actorType ?? "legacy",
        snapshot.entrypoint,
        snapshot.source,
        snapshot.sqlSource,
        snapshot.parentAuditId,
        snapshot.workspace,
        snapshot.originalQuestion,
        snapshot.generatedSql,
        snapshot.executedSql,
        snapshot.clarification ? JSON.stringify(snapshot.clarification) : null,
        snapshot.finishedAt,
        snapshot.durationMs,
        snapshot.rowCount,
        snapshot.error,
      );
  };
  const publish = (step: QueryStep) => {
    save();
    onProgress?.({ type: "step", auditId: record.id, step: clean(step) });
  };
  const stepFor = (id: QueryStepId) => record.steps.find((step) => step.id === id)!;
  save();
  onProgress?.({ type: "start", auditId: record.id, steps: clean(record.steps) });

  return {
    record,
    addSecret(value: string) {
      if (value) secrets.add(value);
    },
    patch(values: Partial<QueryAuditRecord>) {
      Object.assign(record, values);
      if (values.originalQuestion) record.question = values.originalQuestion;
      if (values.executedSql !== undefined) record.sql = values.executedSql;
      else if (values.generatedSql !== undefined) record.sql = values.generatedSql;
      save();
    },
    /** Persist step-only state changed by orchestration without pretending it was a patch. */
    persist() {
      save();
    },
    start(id: QueryStepId, input?: Record<string, unknown>) {
      const step = stepFor(id);
      Object.assign(step, { status: "running", startedAt: new Date().toISOString(), input });
      publish(step);
    },
    complete(id: QueryStepId, message: string, output?: Record<string, unknown>) {
      const step = stepFor(id);
      const finishedAt = new Date().toISOString();
      Object.assign(step, {
        status: "succeeded",
        finishedAt,
        durationMs: Date.parse(finishedAt) - Date.parse(step.startedAt!),
        message,
        output,
      });
      publish(step);
    },
    clarify(clarification: Clarification) {
      record.clarification = clarification;
      record.clarifying = clarification.clarifying;
      record.status = "clarifying";
      record.finishedAt = new Date().toISOString();
      for (const step of record.steps) {
        if (step.status === "pending") {
          step.status = "skipped";
          step.message = "等待补充信息后继续";
          publish(step);
        }
      }
      save();
      onProgress?.({ type: "clarification", auditId: record.id, clarification });
      return clean(record);
    },
    finish(status: Exclude<QueryAuditStatus, "running">, error?: string) {
      for (const step of record.steps) {
        if (step.status === "running") {
          const finishedAt = new Date().toISOString();
          Object.assign(step, {
            status: "failed",
            finishedAt,
            durationMs: Date.parse(finishedAt) - Date.parse(step.startedAt!),
            message: error ?? "步骤执行失败",
          });
          publish(step);
        } else if (step.status === "pending") {
          step.status = "skipped";
          step.message = status === "clarifying" ? "等待补充信息后继续" : "上游步骤失败，未执行";
          publish(step);
        }
      }
      record.status = status;
      record.error = error ?? null;
      record.finishedAt = new Date().toISOString();
      save();
      return clean(record);
    },
  };
}

/** 部署 operator 的稳定标识：只用于审计，不冒充真实员工身份。 */
export function resolveOperatorActor(
  req: { header(name: string): string | undefined },
  options: { allowExplicitOperator?: boolean } = {},
): string {
  const token = req.header("authorization");
  if (token?.trim()) return operatorActorForToken(token);
  const explicit = options.allowExplicitOperator ? req.header("x-operator-id")?.trim() : undefined;
  if (explicit)
    return `operator:${createHash("sha256").update(explicit).digest("hex").slice(0, 16)}`;
  return DEFAULT_ACTOR;
}
