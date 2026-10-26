/**
 * 定时报表的 tick 循环。
 *
 * 不引入 cron 依赖:按固定间隔醒来,把「到点且启用」的报表依次跑一遍。
 * 所有外部依赖(时钟、待执行清单、执行器)都可注入,便于测试与嵌入式部署。
 */
import { logTrace, truncate } from "../../platform/trace.js";
import { listDueScheduledReports, type ScheduledReport } from "./store.js";
import { runScheduledReport } from "./runner.js";

/** 默认 1 分钟轮询:分钟级精度足够,也对 SQLite 足够友好。 */
export const DEFAULT_REPORT_TICK_MS = 60_000;

export interface ReportSchedulerDeps {
  intervalMs?: number;
  now?: () => number;
  listDue?: (at: number) => ScheduledReport[];
  run?: (report: ScheduledReport) => Promise<unknown>;
}

export interface ReportScheduler {
  /** 启动周期轮询;重复调用是幂等的。 */
  start(): void;
  stop(): void;
  /** 手动触发一次 tick(测试与运维排障用),返回本次执行的报表数。 */
  tick(): Promise<number>;
  /** 当前是否正在执行(防止 tick 重入)。 */
  isRunning(): boolean;
  lastTickAt(): number | null;
}

export function createReportScheduler(deps: ReportSchedulerDeps = {}): ReportScheduler {
  const intervalMs = Math.max(1_000, deps.intervalMs ?? DEFAULT_REPORT_TICK_MS);
  const now = deps.now ?? Date.now;
  const listDue = deps.listDue ?? ((at: number) => listDueScheduledReports(at));
  const run = deps.run ?? ((report: ScheduledReport) => runScheduledReport(report.id));
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let lastTick: number | null = null;

  const tick = async (): Promise<number> => {
    if (running) return 0;
    running = true;
    try {
      const at = now();
      lastTick = at;
      const due = listDue(at);
      let executed = 0;
      for (const report of due) {
        try {
          await run(report);
          executed += 1;
        } catch (error) {
          // 单条失败不影响同批次其他报表;执行器自身负责落 failed 记录。
          const message = error instanceof Error ? error.message : String(error);
          logTrace(
            "reports.scheduler_error",
            { reportId: report.id, error: truncate(message, 200) },
            "warn",
          );
        }
      }
      return executed;
    } finally {
      running = false;
    }
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void tick();
      }, intervalMs);
      // 不阻塞进程退出(测试与 CLI 场景)。
      timer.unref?.();
      logTrace("reports.scheduler_started", { intervalMs });
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      logTrace("reports.scheduler_stopped", {});
    },
    tick,
    isRunning: () => running,
    lastTickAt: () => lastTick,
  };
}

/** 生产入口:环境变量可覆盖轮询间隔,REPORT_SCHEDULER=off 可整体关闭。 */
export function startReportScheduler(deps: ReportSchedulerDeps = {}): ReportScheduler {
  const configured = Number(process.env.REPORT_SCHEDULER_INTERVAL_MS);
  const intervalMs = deps.intervalMs ?? (Number.isFinite(configured) ? configured : undefined);
  const scheduler = createReportScheduler({ ...deps, ...(intervalMs ? { intervalMs } : {}) });
  if (process.env.REPORT_SCHEDULER !== "off") scheduler.start();
  return scheduler;
}
