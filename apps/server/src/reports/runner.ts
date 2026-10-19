/**
 * 定时报表执行器:复用问数链路(oneapiDemo/text2sql 的 runSchemaText2Sql)跑同一问,
 * 把状态、耗时与结果快照写进 report_runs。
 *
 * 查询入口通过 ReportExecutor 注入:默认是真实链路,测试可替换成假的执行器,
 * 这样调度器与路由都能在没有数据库/模型的环境里被完整覆盖。
 */
import { logTrace, truncate } from "../trace.js";
import { runSchemaText2Sql } from "../oneapiDemo/text2sql.js";
import type { ResultCheck } from "../oneapiDemo/resultChecks.js";
import {
  finishReportRun,
  getScheduledReport,
  recordReportOutcome,
  startReportRun,
  type ReportRun,
  type ReportRunTrigger,
  type ScheduledReport,
} from "./store.js";
import { nextRunAt } from "./schedule.js";

/** 执行器只依赖问数结果里的这几个字段,避免把整条观测链路的结构耦合进报表模块。 */
export interface ReportExecutionResult {
  rows?: Record<string, unknown>[];
  sql?: string | null;
  truncated?: boolean;
  error?: string | null;
  clarifying?: string | null;
  checks?: ResultCheck[];
  auditId?: string | null;
}

export interface ReportExecutorInput {
  report: ScheduledReport;
}

export type ReportExecutor = (input: ReportExecutorInput) => Promise<ReportExecutionResult>;

/** 审计里区分触发方:调度器与人工点击共用一个稳定前缀,便于筛选。 */
export const REPORT_ACTOR = "scheduler:report";

export const defaultReportExecutor: ReportExecutor = async ({ report }) => {
  const result = await runSchemaText2Sql(
    report.sourceId ?? undefined,
    report.question,
    [],
    undefined,
    {
      audit: {
        actor: REPORT_ACTOR,
        // 问数审计的 entrypoint 枚举暂无 report 值,先用 unknown 保持可读。
        entrypoint: "unknown",
        source: "generated",
        workspace: report.workspace,
        originalQuestion: report.question,
      },
    },
  );
  return {
    rows: result.rows,
    sql: result.executedSql ?? result.sql ?? null,
    truncated: result.truncated === true,
    error: result.error ?? null,
    clarifying: result.clarifying ?? null,
    checks: result.checks,
    auditId: result.auditId,
  };
};

let executor: ReportExecutor = defaultReportExecutor;

/** 测试注入口:传 null 恢复默认真实链路。 */
export function setReportExecutor(next: ReportExecutor | null): void {
  executor = next ?? defaultReportExecutor;
}

export function getReportExecutor(): ReportExecutor {
  return executor;
}

export interface RunReportOptions {
  trigger?: ReportRunTrigger;
  now?: () => number;
  execute?: ReportExecutor;
}

/**
 * 执行一次报表并把结果快照落库。
 *
 * - 查询失败不抛异常:失败也要留下 run 记录,否则历史里会凭空少一次;
 * - 执行器抛异常同样落一条 failed,并把错误写进 error 字段;
 * - 无论成功失败都会排下一次运行,避免一次失败让报表静默消失。
 */
export async function runScheduledReport(
  reportId: string,
  options: RunReportOptions = {},
): Promise<ReportRun> {
  const now = options.now ?? Date.now;
  const trigger = options.trigger ?? "schedule";
  const execute = options.execute ?? executor;
  const report = getScheduledReport(reportId);
  if (!report) throw new Error(`定时报表不存在:${reportId}`);

  const startedAt = now();
  const record = startReportRun({
    reportId: report.id,
    workspace: report.workspace,
    trigger,
    question: report.question,
    sourceId: report.sourceId,
    startedAt,
  });

  const finish = (
    status: Exclude<ReportRun["status"], "running">,
    payload: {
      rows?: Record<string, unknown>[];
      sql?: string | null;
      truncated?: boolean;
      error?: string | null;
      checks?: ResultCheck[];
      auditId?: string | null;
    },
  ): ReportRun => {
    const finishedAt = now();
    const rows = payload.rows ?? [];
    const saved = finishReportRun(record.id, {
      status,
      finishedAt,
      durationMs: Math.max(0, finishedAt - startedAt),
      rowCount: payload.rows ? rows.length : null,
      truncated: payload.truncated === true,
      sql: payload.sql ?? null,
      error: payload.error ?? null,
      auditId: payload.auditId ?? null,
      columns: Object.keys(rows[0] ?? {}),
      preview: rows,
      checks: payload.checks ?? [],
    });
    recordReportOutcome(report.id, {
      ranAt: finishedAt,
      status,
      nextRunAtMs: report.enabled ? nextRunAt(report.schedule, finishedAt) : null,
    });
    logTrace("reports.run", {
      reportId: report.id,
      trigger,
      status,
      rowCount: saved.rowCount,
      durationMs: saved.durationMs,
    });
    return saved;
  };

  try {
    const result = await execute({ report });
    if (result.error) return finish("failed", { ...result, error: result.error });
    if (result.clarifying && !result.rows) {
      // 定时任务没有追问的交互空间,把澄清文案当成失败原因暴露出来。
      return finish("clarifying", { ...result, error: result.clarifying });
    }
    return finish("succeeded", result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logTrace("reports.run_error", { reportId: report.id, error: truncate(message, 200) }, "warn");
    return finish("failed", { error: message });
  }
}
