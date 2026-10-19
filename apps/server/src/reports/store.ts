/**
 * 定时报表的 SQLite 存储(报表定义 + 每次运行的结果快照)。
 *
 * 建表风格与 `observatory/queryAudit.ts` 一致:表结构在模块内按需创建,
 * 不动 `db.ts` 的既有 schema,存量库升级时只做 CREATE TABLE IF NOT EXISTS。
 */
import { randomUUID } from "node:crypto";
import { openDb } from "../db.js";
import { DEFAULT_WORKSPACE_ID } from "../workspace.js";
import type { ReportSchedule } from "./schedule.js";

export type ReportRunStatus = "running" | "succeeded" | "failed" | "clarifying";
export type ReportRunTrigger = "schedule" | "manual";

/** 结果快照的落库上限:报表历史是给人看的预览,不做全量归档。 */
export const RUN_PREVIEW_ROW_LIMIT = 20;

export interface ScheduledReport {
  id: string;
  workspace: string;
  name: string;
  question: string;
  sourceId: string | null;
  schedule: ReportSchedule;
  enabled: boolean;
  /** 下一次执行时刻(ISO);停用或未排期时为 null。 */
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: ReportRunStatus | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReportRun {
  id: string;
  reportId: string;
  workspace: string;
  trigger: ReportRunTrigger;
  status: ReportRunStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number;
  rowCount: number | null;
  truncated: boolean;
  sql: string | null;
  error: string | null;
  auditId: string | null;
  columns: string[];
  preview: Record<string, unknown>[];
  checks: unknown[];
}

export interface ReportCreateInput {
  workspace?: string;
  name: string;
  question: string;
  sourceId?: string | null;
  schedule: ReportSchedule;
  enabled?: boolean;
}

export interface ReportUpdatePatch {
  name?: string;
  question?: string;
  sourceId?: string | null;
  schedule?: ReportSchedule;
  enabled?: boolean;
}

interface ReportRow {
  id: string;
  workspace_id: string;
  name: string;
  question: string;
  source_id: string | null;
  frequency: string;
  time_of_day: string;
  weekday: number | null;
  enabled: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_status: string | null;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  report_id: string;
  workspace_id: string;
  trigger: string;
  status: string;
  started_at: number;
  finished_at: number | null;
  duration_ms: number;
  row_count: number | null;
  truncated: number;
  sql: string | null;
  error: string | null;
  audit_id: string | null;
  columns_json: string;
  preview_json: string;
  checks_json: string;
}

function now(): string {
  return new Date().toISOString();
}

function database() {
  const db = openDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_reports (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL DEFAULT '${DEFAULT_WORKSPACE_ID}',
      name TEXT NOT NULL,
      question TEXT NOT NULL,
      source_id TEXT,
      frequency TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly')),
      time_of_day TEXT NOT NULL,
      weekday INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      next_run_at INTEGER,
      last_run_at INTEGER,
      last_status TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_scheduled_reports_workspace
      ON scheduled_reports(workspace_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_scheduled_reports_due
      ON scheduled_reports(enabled, next_run_at);

    CREATE TABLE IF NOT EXISTS report_runs (
      id TEXT PRIMARY KEY,
      report_id TEXT NOT NULL REFERENCES scheduled_reports(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL DEFAULT '${DEFAULT_WORKSPACE_ID}',
      trigger TEXT NOT NULL DEFAULT 'schedule' CHECK (trigger IN ('schedule', 'manual')),
      status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'clarifying')),
      question TEXT NOT NULL,
      source_id TEXT,
      audit_id TEXT,
      sql TEXT,
      row_count INTEGER,
      truncated INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      columns_json TEXT NOT NULL DEFAULT '[]',
      preview_json TEXT NOT NULL DEFAULT '[]',
      checks_json TEXT NOT NULL DEFAULT '[]',
      started_at INTEGER NOT NULL,
      finished_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_report_runs_report_started
      ON report_runs(report_id, started_at DESC);
  `);
  return db;
}

function toIso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isFrequency(value: string): value is ReportSchedule["frequency"] {
  return value === "daily" || value === "weekly";
}

function isRunStatus(value: string): value is ReportRunStatus {
  return (
    value === "running" || value === "succeeded" || value === "failed" || value === "clarifying"
  );
}

function rowToReport(row: ReportRow): ScheduledReport {
  const frequency = isFrequency(row.frequency) ? row.frequency : "daily";
  return {
    id: row.id,
    workspace: row.workspace_id,
    name: row.name,
    question: row.question,
    sourceId: row.source_id,
    schedule: {
      frequency,
      time: row.time_of_day,
      ...(frequency === "weekly" ? { weekday: row.weekday ?? 0 } : {}),
    },
    enabled: row.enabled === 1,
    nextRunAt: toIso(row.next_run_at),
    lastRunAt: toIso(row.last_run_at),
    lastStatus: row.last_status && isRunStatus(row.last_status) ? row.last_status : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToRun(row: RunRow): ReportRun {
  return {
    id: row.id,
    reportId: row.report_id,
    workspace: row.workspace_id,
    trigger: row.trigger === "manual" ? "manual" : "schedule",
    status: isRunStatus(row.status) ? row.status : "failed",
    startedAt: new Date(row.started_at).toISOString(),
    finishedAt: toIso(row.finished_at),
    durationMs: row.duration_ms,
    rowCount: row.row_count,
    truncated: row.truncated === 1,
    sql: row.sql,
    error: row.error,
    auditId: row.audit_id,
    columns: parseJsonArray(row.columns_json).filter(
      (item): item is string => typeof item === "string",
    ),
    preview: parseJsonArray(row.preview_json).filter(
      (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object",
    ),
    checks: parseJsonArray(row.checks_json),
  };
}

export function createScheduledReport(input: ReportCreateInput): ScheduledReport {
  const db = database();
  const timestamp = now();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO scheduled_reports
       (id, workspace_id, name, question, source_id, frequency, time_of_day, weekday,
        enabled, next_run_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.workspace?.trim() || DEFAULT_WORKSPACE_ID,
    input.name,
    input.question,
    input.sourceId ?? null,
    input.schedule.frequency,
    input.schedule.time,
    input.schedule.weekday ?? null,
    input.enabled === false ? 0 : 1,
    null,
    timestamp,
    timestamp,
  );
  return getScheduledReport(id)!;
}

export function listScheduledReports(workspace?: string): ScheduledReport[] {
  const rows = (
    workspace
      ? database()
          .prepare(
            `SELECT * FROM scheduled_reports WHERE workspace_id = ?
             ORDER BY created_at DESC`,
          )
          .all(workspace)
      : database()
          .prepare(`SELECT * FROM scheduled_reports ORDER BY created_at DESC`)
          .all()
  ) as unknown as ReportRow[];
  return rows.map(rowToReport);
}

export function getScheduledReport(id: string): ScheduledReport | null {
  const row = database().prepare(`SELECT * FROM scheduled_reports WHERE id = ?`).get(id) as
    | ReportRow
    | undefined;
  return row ? rowToReport(row) : null;
}

export function updateScheduledReport(
  id: string,
  patch: ReportUpdatePatch,
): ScheduledReport | null {
  const current = getScheduledReport(id);
  if (!current) return null;
  const schedule = patch.schedule ?? current.schedule;
  database()
    .prepare(
      `UPDATE scheduled_reports
       SET name = ?, question = ?, source_id = ?, frequency = ?, time_of_day = ?, weekday = ?,
           enabled = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      patch.name ?? current.name,
      patch.question ?? current.question,
      patch.sourceId === undefined ? current.sourceId : patch.sourceId,
      schedule.frequency,
      schedule.time,
      schedule.weekday ?? null,
      (patch.enabled ?? current.enabled) ? 1 : 0,
      now(),
      id,
    );
  return getScheduledReport(id);
}

export function deleteScheduledReport(id: string): boolean {
  const db = database();
  db.prepare(`DELETE FROM report_runs WHERE report_id = ?`).run(id);
  const result = db.prepare(`DELETE FROM scheduled_reports WHERE id = ?`).run(id);
  return result.changes > 0;
}

/** 到点且启用的报表(调度器 tick 的输入)。 */
export function listDueScheduledReports(at: number, limit = 20): ScheduledReport[] {
  const rows = database()
    .prepare(
      `SELECT * FROM scheduled_reports
       WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
       ORDER BY next_run_at ASC
       LIMIT ?`,
    )
    .all(at, limit) as unknown as ReportRow[];
  return rows.map(rowToReport);
}

/** 写入排期字段:报表创建/更新后由路由或执行器计算下一次执行时间。 */
export function scheduleScheduledReport(id: string, nextRunAtMs: number | null): void {
  database()
    .prepare(`UPDATE scheduled_reports SET next_run_at = ?, updated_at = ? WHERE id = ?`)
    .run(nextRunAtMs, now(), id);
}

export function startReportRun(input: {
  reportId: string;
  workspace?: string;
  trigger: ReportRunTrigger;
  question: string;
  sourceId?: string | null;
  startedAt: number;
}): ReportRun {
  const id = randomUUID();
  database()
    .prepare(
      `INSERT INTO report_runs
         (id, report_id, workspace_id, trigger, status, question, source_id, started_at)
       VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`,
    )
    .run(
      id,
      input.reportId,
      input.workspace?.trim() || DEFAULT_WORKSPACE_ID,
      input.trigger,
      input.question,
      input.sourceId ?? null,
      input.startedAt,
    );
  return getReportRun(id)!;
}

export function finishReportRun(
  id: string,
  result: {
    status: Exclude<ReportRunStatus, "running">;
    finishedAt: number;
    durationMs: number;
    rowCount?: number | null;
    truncated?: boolean;
    sql?: string | null;
    error?: string | null;
    auditId?: string | null;
    columns?: string[];
    preview?: Record<string, unknown>[];
    checks?: unknown[];
  },
): ReportRun {
  database()
    .prepare(
      `UPDATE report_runs
       SET status = ?, finished_at = ?, duration_ms = ?, row_count = ?, truncated = ?,
           sql = ?, error = ?, audit_id = ?, columns_json = ?, preview_json = ?, checks_json = ?
       WHERE id = ?`,
    )
    .run(
      result.status,
      result.finishedAt,
      result.durationMs,
      result.rowCount ?? null,
      result.truncated ? 1 : 0,
      result.sql ?? null,
      result.error ?? null,
      result.auditId ?? null,
      JSON.stringify(result.columns ?? []),
      JSON.stringify((result.preview ?? []).slice(0, RUN_PREVIEW_ROW_LIMIT)),
      JSON.stringify(result.checks ?? []),
      id,
    );
  return getReportRun(id)!;
}

export function getReportRun(id: string): ReportRun | null {
  const row = database().prepare(`SELECT * FROM report_runs WHERE id = ?`).get(id) as
    | RunRow
    | undefined;
  return row ? rowToRun(row) : null;
}

export function listReportRuns(reportId: string, limit = 20): ReportRun[] {
  const rows = database()
    .prepare(
      `SELECT * FROM report_runs WHERE report_id = ?
       ORDER BY started_at DESC, rowid DESC LIMIT ?`,
    )
    .all(reportId, Math.max(1, Math.min(100, limit))) as unknown as RunRow[];
  return rows.map(rowToRun);
}

/** 运行结束后回写报表的「最近一次」状态,列表页不必再逐条查子表。 */
export function recordReportOutcome(
  reportId: string,
  outcome: { ranAt: number; status: ReportRunStatus; nextRunAtMs: number | null },
): void {
  database()
    .prepare(
      `UPDATE scheduled_reports
       SET last_run_at = ?, last_status = ?, next_run_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(outcome.ranAt, outcome.status, outcome.nextRunAtMs, now(), reportId);
}
