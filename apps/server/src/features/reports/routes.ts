import { Router, type Request, type Response } from "express";
import { logTrace } from "../../platform/trace.js";
import { resolveWorkspace } from "../../platform/workspace/store.js";
import { getSchemaSource } from "../query/schema/store.js";
import { nextRunAt, parseReportSchedule } from "./schedule.js";
import {
  createScheduledReport,
  deleteScheduledReport,
  getScheduledReport,
  listReportRuns,
  listScheduledReports,
  scheduleScheduledReport,
  updateScheduledReport,
  type ReportUpdatePatch,
  type ScheduledReport,
} from "./store.js";
import { runScheduledReport } from "./runner.js";

export const reportsRouter: ReturnType<typeof Router> = Router();

const NAME_MAX_LENGTH = 120;
const QUESTION_MAX_LENGTH = 2_000;

/** 列表与详情共用的出参:补一次 nextRunAt,避免前端自己算排期。 */
function publicReport(report: ScheduledReport): ScheduledReport {
  if (report.enabled && !report.nextRunAt) {
    const scheduled = nextRunAt(report.schedule, Date.now());
    scheduleScheduledReport(report.id, scheduled);
    return { ...report, nextRunAt: new Date(scheduled).toISOString() };
  }
  return report;
}

/** 停用或未排期都不该留在待执行清单里。 */
function reschedule(report: ScheduledReport, enabled: boolean): void {
  scheduleScheduledReport(report.id, enabled ? nextRunAt(report.schedule, Date.now()) : null);
}

function parseBody(req: Request): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

interface ParsedReportInput {
  ok: true;
  value: {
    name: string;
    question: string;
    sourceId: string | null;
    frequency: unknown;
    time: unknown;
    weekday: unknown;
    enabled: boolean;
  };
}

function parseReportInput(
  body: Record<string, unknown>,
): ParsedReportInput | { ok: false; error: string } {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return { ok: false, error: "name 不能为空" };
  if (name.length > NAME_MAX_LENGTH)
    return { ok: false, error: `name 不能超过 ${NAME_MAX_LENGTH} 字` };
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) return { ok: false, error: "question 不能为空" };
  if (question.length > QUESTION_MAX_LENGTH) {
    return { ok: false, error: `question 不能超过 ${QUESTION_MAX_LENGTH} 字` };
  }
  const sourceIdRaw = body.sourceId;
  const sourceId =
    typeof sourceIdRaw === "string" && sourceIdRaw.trim() ? sourceIdRaw.trim() : null;
  if (sourceId && !getSchemaSource(sourceId)) {
    return { ok: false, error: `数据源不存在:${sourceId}` };
  }
  return {
    ok: true,
    value: {
      name,
      question,
      sourceId,
      frequency: body.frequency,
      time: body.time,
      weekday: body.weekday,
      enabled: parseBoolean(body.enabled, true),
    },
  };
}

/** 列表:默认按请求 workspace 归集,`workspaceId=*` 查看全局。 */
reportsRouter.get("/api/admin/reports", (req: Request, res: Response) => {
  const workspace = resolveWorkspace(req);
  if (!workspace.ok) {
    res.status(400).json({ error: `workspace not found: ${workspace.requested}` });
    return;
  }
  const scopeAll = req.query.workspaceId === "*";
  const reports = listScheduledReports(scopeAll ? undefined : workspace.workspaceId).map(
    publicReport,
  );
  res.json({ reports });
});

reportsRouter.post("/api/admin/reports", (req: Request, res: Response) => {
  const workspace = resolveWorkspace(req);
  if (!workspace.ok) {
    res.status(400).json({ error: `workspace not found: ${workspace.requested}` });
    return;
  }
  const parsed = parseReportInput(parseBody(req));
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const schedule = parseReportSchedule({
    frequency: parsed.value.frequency,
    time: parsed.value.time,
    weekday: parsed.value.weekday,
  });
  if (!schedule.ok) {
    res.status(400).json({ error: schedule.error });
    return;
  }
  const report = createScheduledReport({
    workspace: workspace.workspaceId,
    name: parsed.value.name,
    question: parsed.value.question,
    sourceId: parsed.value.sourceId,
    schedule: schedule.value,
    enabled: parsed.value.enabled,
  });
  reschedule(report, report.enabled);
  const saved = getScheduledReport(report.id)!;
  logTrace("reports.created", {
    reportId: saved.id,
    workspace: saved.workspace,
    frequency: saved.schedule.frequency,
  });
  res.status(201).json({ report: saved });
});

reportsRouter.get("/api/admin/reports/:id", (req: Request, res: Response) => {
  const report = findReport(req, res);
  if (!report) return;
  res.json({ report: publicReport(report), runs: listReportRuns(report.id, 20) });
});

reportsRouter.put("/api/admin/reports/:id", (req: Request, res: Response) => {
  const report = findReport(req, res);
  if (!report) return;
  const body = parseBody(req);
  // 局部更新:未提供的字段沿用当前值,避免「只改启停」被当成缺字段拒绝。
  const parsed = parseReportInput({
    name: typeof body.name === "string" ? body.name : report.name,
    question: typeof body.question === "string" ? body.question : report.question,
    sourceId: body.sourceId === undefined ? report.sourceId : body.sourceId,
    frequency: body.frequency ?? report.schedule.frequency,
    time: body.time ?? report.schedule.time,
    weekday: body.weekday ?? report.schedule.weekday,
    enabled: parseBoolean(body.enabled, report.enabled),
  });
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const schedule = parseReportSchedule({
    frequency: parsed.value.frequency,
    time: parsed.value.time,
    weekday: parsed.value.weekday,
  });
  if (!schedule.ok) {
    res.status(400).json({ error: schedule.error });
    return;
  }
  const patch: ReportUpdatePatch = {
    name: parsed.value.name,
    question: parsed.value.question,
    sourceId: parsed.value.sourceId,
    schedule: schedule.value,
    enabled: parseBoolean(body.enabled, report.enabled),
  };
  const updated = updateScheduledReport(report.id, patch)!;
  reschedule(updated, updated.enabled);
  res.json({ report: getScheduledReport(report.id)! });
});

reportsRouter.delete("/api/admin/reports/:id", (req: Request, res: Response) => {
  const report = findReport(req, res);
  if (!report) return;
  deleteScheduledReport(report.id);
  logTrace("reports.deleted", { reportId: report.id });
  res.json({ ok: true });
});

/** 立即运行一次:手动触发不影响周期定义,但会更新最近一次状态与历史。 */
reportsRouter.post("/api/admin/reports/:id/run", async (req: Request, res: Response) => {
  const report = findReport(req, res);
  if (!report) return;
  try {
    const run = await runScheduledReport(report.id, { trigger: "manual" });
    res.json({ run, report: publicReport(getScheduledReport(report.id)!) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

reportsRouter.get("/api/admin/reports/:id/runs", (req: Request, res: Response) => {
  const report = findReport(req, res);
  if (!report) return;
  const limit = Number(req.query.limit);
  res.json({ runs: listReportRuns(report.id, Number.isFinite(limit) ? limit : 20) });
});

/** 归属校验与 404 一起处理,避免上层重复写 workspace 判断。 */
function findReport(req: Request, res: Response): ScheduledReport | null {
  const workspace = resolveWorkspace(req);
  if (!workspace.ok) {
    res.status(400).json({ error: `workspace not found: ${workspace.requested}` });
    return null;
  }
  const report = getScheduledReport(String(req.params.id));
  if (!report || report.workspace !== workspace.workspaceId) {
    res.status(404).json({ error: "定时报表不存在" });
    return null;
  }
  return report;
}
