import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { closeDb } from "../db.js";
import {
  createScheduledReport,
  deleteScheduledReport,
  finishReportRun,
  getReportRun,
  getScheduledReport,
  listDueScheduledReports,
  listReportRuns,
  listScheduledReports,
  recordReportOutcome,
  scheduleScheduledReport,
  startReportRun,
  updateScheduledReport,
} from "./store.js";

describe("定时报表存储", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "open-agent-tools-reports-"));
    process.env.SQLITE_PATH = join(dir, "test.sqlite");
    closeDb();
  });

  afterEach(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SQLITE_PATH;
  });

  it("创建后可按 workspace 列出,并按周期回读", () => {
    const daily = createScheduledReport({
      name: "每日活跃用户",
      question: "昨天的活跃用户有多少?",
      schedule: { frequency: "daily", time: "09:00" },
    });
    createScheduledReport({
      workspace: "other",
      name: "周报",
      question: "本周渠道权重",
      schedule: { frequency: "weekly", time: "08:00", weekday: 1 },
    });

    assert.equal(daily.enabled, true);
    assert.equal(daily.sourceId, null);
    assert.equal(daily.nextRunAt, null);
    assert.deepEqual(daily.schedule, { frequency: "daily", time: "09:00" });

    const scoped = listScheduledReports("default");
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0]?.id, daily.id);
    assert.equal(listScheduledReports().length, 2);
    assert.deepEqual(listScheduledReports("other")[0]?.schedule, {
      frequency: "weekly",
      time: "08:00",
      weekday: 1,
    });
  });

  it("更新周期与启停状态,停用后不再进入待执行清单", () => {
    const report = createScheduledReport({
      name: "日报",
      question: "昨天订单量",
      schedule: { frequency: "daily", time: "09:00" },
    });
    scheduleScheduledReport(report.id, 1_000);
    assert.equal(listDueScheduledReports(1_000).length, 1);

    const updated = updateScheduledReport(report.id, {
      name: "日报(改)",
      schedule: { frequency: "weekly", time: "07:30", weekday: 3 },
      enabled: false,
    });
    assert.equal(updated?.name, "日报(改)");
    assert.deepEqual(updated?.schedule, { frequency: "weekly", time: "07:30", weekday: 3 });
    assert.equal(updated?.enabled, false);
    assert.equal(listDueScheduledReports(1_000).length, 0);

    // 未知 id 不抛异常,返回 null 由路由给 404。
    assert.equal(updateScheduledReport("missing", { name: "x" }), null);
    assert.equal(getScheduledReport("missing"), null);
  });

  it("记录运行历史与结果快照,预览行数有上限", () => {
    const report = createScheduledReport({
      name: "明细",
      question: "最近 100 条订单",
      schedule: { frequency: "daily", time: "10:00" },
    });
    const rows = Array.from({ length: 25 }, (_, index) => ({ id: index + 1 }));
    const run = startReportRun({
      reportId: report.id,
      trigger: "manual",
      question: report.question,
      sourceId: report.sourceId,
      startedAt: 5_000,
    });
    assert.equal(run.status, "running");
    assert.equal(run.trigger, "manual");

    const finished = finishReportRun(run.id, {
      status: "succeeded",
      finishedAt: 5_120,
      durationMs: 120,
      rowCount: rows.length,
      truncated: true,
      sql: "SELECT id FROM orders LIMIT 100",
      auditId: "audit-1",
      columns: ["id"],
      preview: rows,
      checks: [{ code: "truncated", level: "info", message: "结果已截断" }],
    });
    assert.equal(finished.durationMs, 120);
    assert.equal(finished.columns[0], "id");
    assert.equal(finished.preview.length, 20);
    assert.equal(finished.truncated, true);
    assert.equal(finished.checks.length, 1);

    recordReportOutcome(report.id, { ranAt: 5_120, status: "succeeded", nextRunAtMs: 5_000 });
    const reloaded = getScheduledReport(report.id)!;
    assert.equal(reloaded.lastStatus, "succeeded");
    assert.equal(reloaded.nextRunAt, new Date(5_000).toISOString());

    assert.equal(listReportRuns(report.id).length, 1);
    assert.equal(getReportRun(run.id)?.sql, "SELECT id FROM orders LIMIT 100");
    assert.equal(listDueScheduledReports(5_000).length, 1);
  });

  it("删除报表时级联清理运行历史", () => {
    const report = createScheduledReport({
      name: "临时",
      question: "任意一问",
      schedule: { frequency: "daily", time: "11:00" },
    });
    const run = startReportRun({
      reportId: report.id,
      trigger: "schedule",
      question: report.question,
      startedAt: 1,
    });
    assert.equal(listReportRuns(report.id).length, 1);
    assert.equal(deleteScheduledReport(report.id), true);
    assert.equal(getScheduledReport(report.id), null);
    assert.equal(listReportRuns(report.id).length, 0);
    assert.equal(getReportRun(run.id), null);
    assert.equal(deleteScheduledReport(report.id), false);
  });
});
