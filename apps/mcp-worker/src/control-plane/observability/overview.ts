import type { AuditService } from "../audit.js";
import { ManagementError, type McpManagementService } from "../management.js";
import type { Actor, BuildJobSummary } from "../types.js";
import { summarizeAuditEvents, type AuditStats } from "./audit-stats.js";
import {
  DEFAULT_ALERT_THRESHOLDS,
  evaluateAlerts,
  type AlertThresholds,
  type ObservabilityAlert,
} from "./alerts.js";
import { EMPTY_QUEUE_SNAPSHOT, type QueueMonitor, type QueueSnapshot } from "./queue-monitor.js";

export interface BuildJobStats {
  total: number;
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
}

/** 汇总构建任务状态分布。 */
export function summarizeBuildJobs(jobs: BuildJobSummary[]): BuildJobStats {
  const stats: BuildJobStats = {
    total: jobs.length,
    queued: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
  };
  for (const job of jobs) {
    switch (job.status) {
      case "QUEUED":
        stats.queued += 1;
        break;
      case "RUNNING":
        stats.running += 1;
        break;
      case "SUCCEEDED":
        stats.succeeded += 1;
        break;
      case "FAILED":
        stats.failed += 1;
        break;
    }
  }
  return stats;
}

export interface ObservabilityOverview {
  generatedAt: string;
  /** 未配置队列监控时为 null。 */
  queue: QueueSnapshot | null;
  audit: AuditStats;
  builds: BuildJobStats;
  alerts: ObservabilityAlert[];
}

export interface ObservabilityServiceOptions {
  management: McpManagementService;
  audit: AuditService;
  queueMonitor?: QueueMonitor;
  thresholds?: AlertThresholds;
  now?: () => Date;
  /** 审计统计窗口，默认 24 小时。 */
  auditWindowMs?: number;
  /** 读取的构建任务条数上限。 */
  buildJobLimit?: number;
}

/**
 * 统一可观测性看板：汇聚队列积压、审计指标、构建任务分布，
 * 并即时评估告警，让管理端一次请求拿到全局健康视图。
 */
export class ObservabilityService {
  readonly #management: McpManagementService;
  readonly #audit: AuditService;
  readonly #queueMonitor?: QueueMonitor;
  readonly #thresholds: AlertThresholds;
  readonly #now: () => Date;
  readonly #auditWindowMs: number;
  readonly #buildJobLimit: number;

  constructor(options: ObservabilityServiceOptions) {
    this.#management = options.management;
    this.#audit = options.audit;
    this.#queueMonitor = options.queueMonitor;
    this.#thresholds = options.thresholds ?? DEFAULT_ALERT_THRESHOLDS;
    this.#now = options.now ?? (() => new Date());
    this.#auditWindowMs = options.auditWindowMs ?? 24 * 60 * 60 * 1_000;
    this.#buildJobLimit = options.buildJobLimit ?? 100;
  }

  async overview(actor: Actor): Promise<ObservabilityOverview> {
    if (actor.role === "operator") {
      throw new ManagementError("FORBIDDEN", "Observability dashboard requires admin or auditor access");
    }
    const now = this.#now();
    const [events, jobs, queue] = await Promise.all([
      // 复用审计服务的权限语义，读取最近事件用于聚合。
      this.#audit.list({ limit: 200 }, actor),
      this.#management.listBuildJobs(this.#buildJobLimit, actor),
      this.#queueMonitor?.snapshot() ?? Promise.resolve(null),
    ]);

    const audit = summarizeAuditEvents(events, { now, windowMs: this.#auditWindowMs });
    const builds = summarizeBuildJobs(jobs);
    const alerts = evaluateAlerts(
      {
        queue: queue ?? EMPTY_QUEUE_SNAPSHOT,
        audit,
      },
      this.#thresholds,
      // 未配置队列监控时跳过队列类告警，避免误报。
      queue ? [] : ["queue.backlog", "queue.failed"],
    );

    return { generatedAt: now.toISOString(), queue, audit, builds, alerts };
  }
}
