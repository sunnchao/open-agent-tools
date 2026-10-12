import { randomUUID } from "node:crypto";
import { redactAuditPayload } from "@open-agent-tools/observability/audit";
import { openDb } from "../db.js";
import type { HistoryTurn } from "../oneapiDemo/text2sql.js";
import type { detectRowLimitIntent } from "../schema-inject.js";

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
}

export interface QueryAuditRecord extends QueryAuditSummary {
  rowLimit?: ReturnType<typeof detectRowLimitIntent>;
  history: HistoryTurn[];
  steps: QueryStep[];
  selectedTables: string[];
  sql: string | null;
  clarifying: string | null;
  providerId: string | null;
  model: string | null;
  resultPreview: Record<string, unknown>[];
}

export type QueryProgressEvent =
  | { type: "start"; auditId: string; steps: QueryStep[] }
  | { type: "step"; auditId: string; step: QueryStep };

function database() {
  const db = openDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS observatory_query_audits (
      id TEXT PRIMARY KEY,
      source_id TEXT,
      status TEXT NOT NULL,
      question TEXT NOT NULL,
      started_at TEXT NOT NULL,
      record_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_observatory_audits_source_started
      ON observatory_query_audits(source_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_observatory_audits_started
      ON observatory_query_audits(started_at DESC);
  `);
  return db;
}

function summary(record: QueryAuditRecord): QueryAuditSummary {
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
  };
}

export function listQueryAudits(filters: {
  sourceId?: string;
  status?: QueryAuditStatus;
  search?: string;
  limit?: number;
  offset?: number;
}): { records: QueryAuditSummary[]; total: number } {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (filters.sourceId) {
    conditions.push("source_id = ?");
    params.push(filters.sourceId);
  }
  if (filters.status) {
    conditions.push("status = ?");
    params.push(filters.status);
  }
  if (filters.search) {
    conditions.push("(instr(lower(question), lower(?)) > 0 OR id = ?)");
    params.push(filters.search, filters.search);
  }
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
    records: rows.map((row) => summary(JSON.parse(row.record_json) as QueryAuditRecord)),
    total,
  };
}

export function getQueryAudit(id: string): QueryAuditRecord | null {
  const row = database()
    .prepare("SELECT record_json FROM observatory_query_audits WHERE id = ?")
    .get(id) as { record_json: string } | undefined;
  if (!row) return null;
  const record = JSON.parse(row.record_json) as QueryAuditRecord;
  if (record.status === "running") {
    record.durationMs = Math.max(0, Date.now() - Date.parse(record.startedAt));
  }
  return record;
}

export function createQueryAudit(
  sourceId: string | undefined,
  question: string,
  history: HistoryTurn[],
  onProgress?: (event: QueryProgressEvent) => void,
) {
  const started = Date.now();
  const secrets = new Set<string>();
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
    steps: QUERY_STEPS.map((step) => ({ ...step, status: "pending" })),
    selectedTables: [],
    sql: null,
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
        `INSERT INTO observatory_query_audits (id, source_id, status, question, started_at, record_json)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET source_id=excluded.source_id, status=excluded.status,
         question=excluded.question, record_json=excluded.record_json`,
      )
      .run(
        record.id,
        record.sourceId,
        record.status,
        snapshot.question,
        record.startedAt,
        JSON.stringify(snapshot),
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
