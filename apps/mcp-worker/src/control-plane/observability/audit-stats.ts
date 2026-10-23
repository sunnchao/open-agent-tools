import type { AuditEventSummary } from "../audit-repository.js";
import { roundTwoDecimals as round } from "./round.js";

/** 单个 action 的聚合统计。 */
export interface AuditActionStat {
  action: string;
  total: number;
  failed: number;
  avgDurationMs: number;
}

export interface AuditStats {
  windowMinutes: number;
  total: number;
  succeeded: number;
  failed: number;
  /** 失败率，0~1；窗口内无事件时为 0。 */
  failureRate: number;
  avgDurationMs: number;
  p95DurationMs: number;
  maxDurationMs: number;
  /** 调用量最高的 action（前 topN）。 */
  topActions: AuditActionStat[];
  /** 最近的失败事件（最新在前，前 topN 条）。 */
  recentFailures: Array<{
    id: string;
    action: string;
    target: string;
    statusCode: number;
    durationMs: number;
    createdAt: string;
  }>;
}

export interface AuditStatsOptions {
  now?: Date;
  /** 统计时间窗口，默认 24 小时。 */
  windowMs?: number;
  topN?: number;
}

/** 线性插值分位数；空数组返回 0。 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(Math.max(p, 0), 1) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower]!;
  const weight = rank - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

/** 汇总审计事件为看板指标：成功率、时延分位、Top action、最近失败。 */
export function summarizeAuditEvents(
  events: AuditEventSummary[],
  options: AuditStatsOptions = {},
): AuditStats {
  const now = options.now ?? new Date();
  const windowMs = options.windowMs ?? 24 * 60 * 60 * 1_000;
  const topN = options.topN ?? 5;
  const cutoff = now.getTime() - windowMs;

  const inWindow = events.filter((event) => {
    const at = Date.parse(event.createdAt);
    return Number.isFinite(at) ? at >= cutoff : true;
  });

  const durations = inWindow.map((event) => Math.max(0, event.durationMs));
  const failed = inWindow.filter((event) => event.outcome === "FAILED");
  const total = inWindow.length;
  const successCount = total - failed.length;

  const byAction = new Map<string, { total: number; failed: number; duration: number }>();
  for (const event of inWindow) {
    const entry = byAction.get(event.action) ?? { total: 0, failed: 0, duration: 0 };
    entry.total += 1;
    entry.duration += Math.max(0, event.durationMs);
    if (event.outcome === "FAILED") entry.failed += 1;
    byAction.set(event.action, entry);
  }

  const topActions: AuditActionStat[] = [...byAction.entries()]
    .map(([action, entry]) => ({
      action,
      total: entry.total,
      failed: entry.failed,
      avgDurationMs: round(entry.duration / entry.total),
    }))
    .sort((a, b) => b.total - a.total || a.action.localeCompare(b.action))
    .slice(0, topN);

  const recentFailures = [...failed]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, topN)
    .map((event) => ({
      id: event.id,
      action: event.action,
      target: event.target,
      statusCode: event.statusCode,
      durationMs: event.durationMs,
      createdAt: event.createdAt,
    }));

  return {
    windowMinutes: Math.round(windowMs / 60_000),
    total,
    succeeded: successCount,
    failed: failed.length,
    failureRate: total === 0 ? 0 : round(failed.length / total),
    avgDurationMs:
      total === 0 ? 0 : round(durations.reduce((sum, value) => sum + value, 0) / total),
    p95DurationMs: round(percentile(durations, 0.95)),
    maxDurationMs: durations.length === 0 ? 0 : Math.max(...durations),
    topActions,
    recentFailures,
  };
}
