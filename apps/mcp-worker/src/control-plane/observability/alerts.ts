import type { AuditStats } from "./audit-stats.js";
import type { QueueSnapshot } from "./queue-monitor.js";

export type AlertSeverity = "warning" | "critical";

export interface ObservabilityAlert {
  /** 稳定的告警标识，便于告警聚合/去重。 */
  id: string;
  severity: AlertSeverity;
  /** 触发的指标名，如 queue.backlog。 */
  metric: string;
  message: string;
  value: number;
  threshold: number;
}

export interface AlertThresholds {
  /** 队列积压警告阈值。 */
  queueBacklog: number;
  /** 队列积压严重阈值。 */
  queueBacklogCritical: number;
  /** 队列失败任务数阈值。 */
  queueFailed: number;
  /** 审计失败率阈值（0~1）。 */
  auditFailureRate: number;
  /** 审计 P95 时延阈值（毫秒）。 */
  auditSlowP95Ms: number;
}

export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = {
  queueBacklog: 20,
  queueBacklogCritical: 100,
  queueFailed: 10,
  auditFailureRate: 0.2,
  auditSlowP95Ms: 2_000,
};

/** 依据队列与审计指标评估告警；无异常时返回空数组。 */
export function evaluateAlerts(
  input: { queue: QueueSnapshot; audit: AuditStats },
  thresholds: AlertThresholds = DEFAULT_ALERT_THRESHOLDS,
  /** 需要跳过的指标名（如未配置队列监控时跳过 queue.*）。 */
  skipMetrics: string[] = [],
): ObservabilityAlert[] {
  const alerts: ObservabilityAlert[] = [];
  const { queue, audit } = input;

  if (queue.backlog >= thresholds.queueBacklog) {
    const critical = queue.backlog >= thresholds.queueBacklogCritical;
    alerts.push({
      id: "queue.backlog",
      severity: critical ? "critical" : "warning",
      metric: "queue.backlog",
      message: critical
        ? `构建队列严重积压：${queue.backlog} 个任务等待处理`
        : `构建队列出现积压：${queue.backlog} 个任务等待处理`,
      value: queue.backlog,
      threshold: critical ? thresholds.queueBacklogCritical : thresholds.queueBacklog,
    });
  }

  if (queue.failed >= thresholds.queueFailed) {
    alerts.push({
      id: "queue.failed",
      severity: "warning",
      metric: "queue.failed",
      message: `构建队列失败任务偏多：${queue.failed} 个`,
      value: queue.failed,
      threshold: thresholds.queueFailed,
    });
  }

  if (audit.total > 0 && audit.failureRate >= thresholds.auditFailureRate) {
    alerts.push({
      id: "audit.failureRate",
      severity: audit.failureRate >= thresholds.auditFailureRate * 2 ? "critical" : "warning",
      metric: "audit.failureRate",
      message: `管理端接口失败率偏高：${(audit.failureRate * 100).toFixed(1)}%（窗口 ${audit.windowMinutes} 分钟）`,
      value: audit.failureRate,
      threshold: thresholds.auditFailureRate,
    });
  }

  if (audit.total > 0 && audit.p95DurationMs >= thresholds.auditSlowP95Ms) {
    alerts.push({
      id: "audit.p95DurationMs",
      severity: "warning",
      metric: "audit.p95DurationMs",
      message: `管理端接口 P95 时延偏高：${audit.p95DurationMs}ms`,
      value: audit.p95DurationMs,
      threshold: thresholds.auditSlowP95Ms,
    });
  }

  return alerts.filter((alert) => !skipMetrics.includes(alert.metric));
}

export interface AlertSink {
  publish(alerts: ObservabilityAlert[]): void | Promise<void>;
}

export interface AlertLoopOptions {
  collect: () => Promise<{ queue: QueueSnapshot; audit: AuditStats }>;
  sinks?: AlertSink[];
  thresholds?: AlertThresholds;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}

export interface AlertLoop {
  runOnce(): Promise<ObservabilityAlert[]>;
  start(): void;
  stop(): void;
}

/**
 * 周期性采集指标并评估告警，命中的结果推送给 sink（如 console / webhook）。
 * 单次评估失败只记日志，不中断循环。
 */
export function createAlertLoop(options: AlertLoopOptions): AlertLoop {
  const thresholds = options.thresholds ?? DEFAULT_ALERT_THRESHOLDS;
  const sinks = options.sinks ?? [];
  const onError = options.onError ?? ((error) => console.error("observability alert failed", error));
  let timer: ReturnType<typeof setInterval> | null = null;

  async function runOnce(): Promise<ObservabilityAlert[]> {
    try {
      const metrics = await options.collect();
      const alerts = evaluateAlerts(metrics, thresholds);
      if (alerts.length > 0) {
        await Promise.all(sinks.map((sink) => sink.publish(alerts)));
      }
      return alerts;
    } catch (error) {
      onError(error);
      return [];
    }
  }

  return {
    runOnce,
    start() {
      if (timer) return;
      timer = setInterval(() => void runOnce(), options.intervalMs ?? 30_000);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
