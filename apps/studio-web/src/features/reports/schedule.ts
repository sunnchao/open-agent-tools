/**
 * 定时报表的展示辅助(纯函数,便于测试)。
 *
 * 服务端用 HH:MM + daily/weekly 描述周期,这里的措辞与它保持一致。
 */
import type { ReportRunStatus } from "./api.js";
export { WEEKDAY_LABELS, describeSchedule } from "@open-agent-tools/api-contracts/report";

export const REPORT_STATUS_LABELS: Record<ReportRunStatus, string> = {
  running: "执行中",
  succeeded: "成功",
  failed: "失败",
  clarifying: "需补充口径",
};

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTimeOfDay(value: string): boolean {
  return TIME_PATTERN.test(value.trim());
}

/** 本地时区展示,避免把 UTC ISO 串直接糊到界面上。 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  const date = new Date(parsed);
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "—";
  return durationMs < 1000 ? `${Math.round(durationMs)} ms` : `${(durationMs / 1000).toFixed(1)} s`;
}

export function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
