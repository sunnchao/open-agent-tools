import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { closeDb } from "../../platform/db.js";
import { createReportScheduler } from "./scheduler.js";
import { getReportExecutor, runScheduledReport, setReportExecutor } from "./runner.js";
import {
  createScheduledReport,
  getScheduledReport,
  listReportRuns,
  scheduleScheduledReport,
  type ScheduledReport,
} from "./store.js";

const NINE_AM = Date.parse("2026-03-01T09:00:00Z");

describe("定时报表执行器", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "open-agent-tools-report-run-"));
    process.env.SQLITE_PATH = join(dir, "test.sqlite");
    closeDb();
  });

  afterEach(() => {
    setReportExecutor(null);
    closeDb();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SQLITE_PATH;
  });

  it("成功时保存结果快照并排下一次运行", async () => {
    const report = createScheduledReport({
      name: "活跃用户",
      question: "昨天活跃用户数",
      schedule: { frequency: "daily", time: "09:00" },
    });
    const run = await runScheduledReport(report.id, {
      trigger: "schedule",
      now: () => NINE_AM,
      execute: async () => ({
        rows: [{ users: 12 }, { users: 15 }],
        sql: "SELECT COUNT(*) AS users FROM users",
        auditId: "audit-9",
        checks: [{ code: "empty_result", level: "info", message: "ok" }],
      }),
    });

    assert.equal(run.status, "succeeded");
    assert.equal(run.rowCount, 2);
    assert.deepEqual(run.columns, ["users"]);
    assert.equal(run.sql, "SELECT COUNT(*) AS users FROM users");
    assert.equal(run.auditId, "audit-9");
    assert.equal(run.durationMs, 0);

    const reloaded = getScheduledReport(report.id)!;
    assert.equal(reloaded.lastStatus, "succeeded");
    assert.equal(reloaded.nextRunAt, new Date(NINE_AM + 24 * 60 * 60 * 1000).toISOString());
  });

  it("失败与澄清都落库,且不影响下一次排期", async () => {
    const report = createScheduledReport({
      name: "渠道权重",
      question: "渠道权重",
      schedule: { frequency: "daily", time: "09:00" },
    });

    const failed = await runScheduledReport(report.id, {
      now: () => NINE_AM,
      execute: async () => ({ error: "SQL 执行失败" }),
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "SQL 执行失败");
    assert.equal(failed.rowCount, null);

    const clarifying = await runScheduledReport(report.id, {
      now: () => NINE_AM,
      execute: async () => ({ clarifying: "请补充时间范围" }),
    });
    assert.equal(clarifying.status, "clarifying");
    assert.equal(clarifying.error, "请补充时间范围");

    const thrown = await runScheduledReport(report.id, {
      now: () => NINE_AM,
      execute: async () => {
        throw new Error("未配置可用 LLM Provider");
      },
    });
    assert.equal(thrown.status, "failed");
    assert.equal(thrown.error, "未配置可用 LLM Provider");

    const reloaded = getScheduledReport(report.id)!;
    assert.equal(reloaded.lastStatus, "failed");
    assert.ok(reloaded.nextRunAt);
    assert.equal(listReportRuns(report.id).length, 3);
  });

  it("默认执行器可注入也可复位", () => {
    const fake = async () => ({});
    setReportExecutor(fake);
    assert.equal(getReportExecutor(), fake);
    setReportExecutor(null);
    assert.notEqual(getReportExecutor(), fake);
  });

  it("未知报表直接报错,不留下孤儿 run", async () => {
    await assert.rejects(() => runScheduledReport("missing"), /定时报表不存在/);
  });
});

describe("定时报表 tick", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "open-agent-tools-report-tick-"));
    process.env.SQLITE_PATH = join(dir, "test.sqlite");
    closeDb();
  });

  afterEach(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SQLITE_PATH;
  });

  it("只执行到点的启用报表,并把排期推进到下一天", async () => {
    const daily = createScheduledReport({
      name: "日报",
      question: "昨天订单量",
      schedule: { frequency: "daily", time: "09:00" },
    });
    const paused = createScheduledReport({
      name: "停用",
      question: "停用的报表",
      schedule: { frequency: "daily", time: "09:00" },
      enabled: false,
    });
    const later = createScheduledReport({
      name: "稍后",
      question: "还没到点",
      schedule: { frequency: "daily", time: "18:00" },
    });
    scheduleScheduledReport(daily.id, NINE_AM);
    scheduleScheduledReport(later.id, NINE_AM + 60_000);

    const executed: string[] = [];
    const scheduler = createReportScheduler({
      intervalMs: 1_000,
      now: () => NINE_AM,
      run: async (report: ScheduledReport) => {
        executed.push(report.name);
        scheduleScheduledReport(report.id, NINE_AM + 24 * 60 * 60 * 1000);
      },
    });

    assert.equal(scheduler.lastTickAt(), null);
    assert.equal(await scheduler.tick(), 1);
    assert.deepEqual(executed, ["日报"]);
    assert.equal(scheduler.lastTickAt(), NINE_AM);
    assert.equal(scheduler.isRunning(), false);
    assert.equal(getScheduledReport(daily.id)?.nextRunAt, new Date(NINE_AM + 86_400_000).toISOString());
    assert.equal(getScheduledReport(paused.id)?.nextRunAt, null);
    // 排期已推进,第二次 tick 不再重复执行。
    assert.equal(await scheduler.tick(), 0);
    assert.deepEqual(executed, ["日报"]);
  });

  it("单条失败不阻断同批次的其他报表", async () => {
    const broken = createScheduledReport({
      name: "失败",
      question: "会失败的一问",
      schedule: { frequency: "daily", time: "09:00" },
    });
    const healthy = createScheduledReport({
      name: "正常",
      question: "正常一问",
      schedule: { frequency: "daily", time: "09:00" },
    });
    scheduleScheduledReport(broken.id, NINE_AM);
    scheduleScheduledReport(healthy.id, NINE_AM);

    const scheduler = createReportScheduler({
      now: () => NINE_AM,
      run: async (report: ScheduledReport) => {
        if (report.id === broken.id) throw new Error("boom");
        scheduleScheduledReport(report.id, null);
      },
    });
    assert.equal(await scheduler.tick(), 1);
    assert.equal(getScheduledReport(healthy.id)?.nextRunAt, null);
  });

  it("start 幂等,stop 后不再触发", async () => {
    const scheduler = createReportScheduler({ intervalMs: 60, now: () => 1 });
    scheduler.start();
    scheduler.start();
    scheduler.stop();
    scheduler.stop();
    assert.equal(await scheduler.tick(), 0);
  });
});
