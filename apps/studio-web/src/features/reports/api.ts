/**
 * C6 定时报表的前端 API 封装。
 *
 * 全部走 `/api/admin/reports`(服务端 manage 分组),浏览器只携带 Studio 部署 token。
 */
import { studioFetch } from "../../lib/client.js";

export type ReportFrequency = "daily" | "weekly";
export type ReportRunStatus = "running" | "succeeded" | "failed" | "clarifying";
export type ReportRunTrigger = "schedule" | "manual";

export interface ReportSchedule {
  frequency: ReportFrequency;
  /** HH:MM(24 小时制)。 */
  time: string;
  /** weekly 必填:0=周日 .. 6=周六。 */
  weekday?: number;
}

export interface ReportCheck {
  code: string;
  level: "info" | "warning";
  message: string;
  column?: string;
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
  checks: ReportCheck[];
}

export interface ScheduledReport {
  id: string;
  workspace: string;
  name: string;
  question: string;
  sourceId: string | null;
  schedule: ReportSchedule;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: ReportRunStatus | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReportDraft {
  name: string;
  question: string;
  sourceId: string | null;
  frequency: ReportFrequency;
  time: string;
  weekday: number;
  enabled: boolean;
}

export interface SchemaSourceOption {
  id: string;
  name: string;
  connector: string;
  databaseName: string | null;
  isDefault: boolean;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await studioFetch(path, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function draftPayload(draft: ReportDraft): Record<string, unknown> {
  return {
    name: draft.name,
    question: draft.question,
    sourceId: draft.sourceId,
    frequency: draft.frequency,
    time: draft.time,
    ...(draft.frequency === "weekly" ? { weekday: draft.weekday } : {}),
    enabled: draft.enabled,
  };
}

export function listReports(): Promise<{ reports: ScheduledReport[] }> {
  return request("/api/admin/reports");
}

export function getReport(id: string): Promise<{ report: ScheduledReport; runs: ReportRun[] }> {
  return request(`/api/admin/reports/${encodeURIComponent(id)}`);
}

export function createReport(draft: ReportDraft): Promise<{ report: ScheduledReport }> {
  return request("/api/admin/reports", jsonInit("POST", draftPayload(draft)));
}

export function updateReport(
  id: string,
  draft: ReportDraft,
): Promise<{ report: ScheduledReport }> {
  return request(
    `/api/admin/reports/${encodeURIComponent(id)}`,
    jsonInit("PUT", draftPayload(draft)),
  );
}

export function deleteReport(id: string): Promise<{ ok: true }> {
  return request(`/api/admin/reports/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function runReportNow(
  id: string,
): Promise<{ run: ReportRun; report: ScheduledReport }> {
  return request(`/api/admin/reports/${encodeURIComponent(id)}/run`, { method: "POST" });
}

export function listReportRuns(id: string, limit = 20): Promise<{ runs: ReportRun[] }> {
  return request(`/api/admin/reports/${encodeURIComponent(id)}/runs?limit=${limit}`);
}

/** 数据源下拉复用公开列表接口(不含连接串与凭据)。 */
export async function listSchemaSources(): Promise<SchemaSourceOption[]> {
  const body = await request<{ sources: SchemaSourceOption[] }>("/api/schema-sources");
  return body.sources;
}
