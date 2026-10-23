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
import {
  resolveSlaWindow,
  summarizeToolSla,
  TOOL_CALL_ACTION,
  type ToolSlaReport,
} from "./tool-sla.js";

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
  /** 工具 SLA 聚合扫描的审计事件上限(AuditService.list 单次读取上限为 200)。 */
  toolSlaScanLimit?: number;
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
  readonly #toolSlaScanLimit: number;

  constructor(options: ObservabilityServiceOptions) {
    this.#management = options.management;
    this.#audit = options.audit;
    this.#queueMonitor = options.queueMonitor;
    this.#thresholds = options.thresholds ?? DEFAULT_ALERT_THRESHOLDS;
    this.#now = options.now ?? (() => new Date());
    this.#auditWindowMs = options.auditWindowMs ?? 24 * 60 * 60 * 1_000;
    this.#buildJobLimit = options.buildJobLimit ?? 100;
    this.#toolSlaScanLimit = Math.min(options.toolSlaScanLimit ?? 200, 200);
  }

  async overview(actor: Actor): Promise<ObservabilityOverview> {
    if (actor.role === "operator") {
      throw new ManagementError(
        "FORBIDDEN",
        "Observability dashboard requires admin or auditor access",
      );
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

  /**
   * 工具 SLA 面板数据源:按「服务 + 工具」聚合成功/失败、时延分位与错误 Top N。
   *
   * 复用既有审计数据(每次 Gateway 请求都会落库),先按 action 过滤出工具调用,
   * 再批量读取完整事件以解析工具名与错误详情。单次扫描上限由 toolSlaScanLimit
   * 控制(默认 200),因此窗口内的较早事件可能被截断,报告中会给出 scan.truncated。
   */
  async toolSla(
    actor: Actor,
    query: { window?: unknown; serviceSlug?: string | null } = {},
  ): Promise<ToolSlaReport> {
    if (actor.role === "operator") {
      throw new ManagementError("FORBIDDEN", "Tool SLA requires admin or auditor access");
    }
    const window = resolveSlaWindow(query.window);
    const limit = this.#toolSlaScanLimit;
    const summaries = await this.#audit.list({ limit, action: TOOL_CALL_ACTION }, actor);
    // 两次读取之间可能清理事件；批量接口会跳过缺失项，并保留摘要顺序。
    const events = await this.#audit.getMany(
      summaries.map((summary) => summary.id),
      actor,
    );
    return summarizeToolSla(events, {
      window,
      now: this.#now(),
      serviceSlug: query.serviceSlug ?? null,
      scanLimit: limit,
    });
  }
}
