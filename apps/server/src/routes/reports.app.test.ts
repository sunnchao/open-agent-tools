import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { createApp } from "../app.js";
import { closeDb } from "../db.js";
import { setReportExecutor } from "../reports/runner.js";
import type { ReportRun, ScheduledReport } from "../reports/store.js";

let server: Server;
let origin: string;
let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "reports-api-test-"));
  process.env.SQLITE_PATH = join(dir, "test.sqlite");
  delete process.env.STUDIO_API_TOKEN;
  delete process.env.SERVER_API_TOKEN;
  delete process.env.OIDC_ISSUER;
  server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  // 查询链路(模型 + 业务库)在这里被替换掉:路由与存储仍然走真实实现。
  setReportExecutor(async () => ({
    rows: [{ users: 3 }, { users: 7 }],
    sql: "SELECT COUNT(*) AS users FROM users",
    auditId: "audit-report",
    checks: [{ code: "empty_result", level: "info", message: "ok" }],
  }));
});

after(async () => {
  setReportExecutor(null);
  server.close();
  await once(server, "close");
  closeDb();
  delete process.env.SQLITE_PATH;
  rmSync(dir, { recursive: true, force: true });
});

async function createReport(body: Record<string, unknown>, workspaceHeader?: string) {
  return fetch(`${origin}/api/admin/reports`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(workspaceHeader ? { "x-workspace-id": workspaceHeader } : {}),
    },
    body: JSON.stringify({
      name: "每日活跃用户",
      question: "昨天的活跃用户有多少?",
      frequency: "daily",
      time: "09:00",
      ...body,
    }),
  });
}

describe("定时报表 API", () => {
  it("创建定时报表并算出下一次执行时刻", async () => {
    const response = await createReport({});
    assert.equal(response.status, 201);
    const { report } = (await response.json()) as { report: ScheduledReport };
    assert.equal(report.name, "每日活跃用户");
    assert.deepEqual(report.schedule, { frequency: "daily", time: "09:00" });
    assert.equal(report.enabled, true);
    assert.ok(report.nextRunAt);
    assert.equal(Date.parse(report.nextRunAt!) % 60_000, 0);

    const list = await fetch(`${origin}/api/admin/reports`);
    assert.equal(list.status, 200);
    const body = (await list.json()) as { reports: ScheduledReport[] };
    assert.ok(body.reports.some((item) => item.id === report.id));
  });

  it("校验名称、问题、周期与数据源", async () => {
    assert.equal((await createReport({ name: "  " })).status, 400);
    assert.equal((await createReport({ question: "" })).status, 400);
    assert.equal((await createReport({ name: "x".repeat(121) })).status, 400);
    assert.equal((await createReport({ frequency: "hourly" })).status, 400);
    assert.equal((await createReport({ time: "25:00" })).status, 400);
    assert.equal((await createReport({ frequency: "weekly" })).status, 400);
    assert.equal((await createReport({ sourceId: "missing-source" })).status, 400);

    const invalid = await createReport({ frequency: "weekly" });
    assert.deepEqual(await invalid.json(), {
      error: "weekly 周期必须提供 weekday(0=周日 .. 6=周六)",
    });
  });

  it("立即运行一次并留下结果快照与历史", async () => {
    const created = (await (await createReport({})).json()) as { report: ScheduledReport };
    const response = await fetch(`${origin}/api/admin/reports/${created.report.id}/run`, {
      method: "POST",
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { run: ReportRun; report: ScheduledReport };
    assert.equal(body.run.status, "succeeded");
    assert.equal(body.run.trigger, "manual");
    assert.equal(body.run.rowCount, 2);
    assert.deepEqual(body.run.columns, ["users"]);
    assert.equal(body.run.preview.length, 2);
    assert.equal(body.run.sql, "SELECT COUNT(*) AS users FROM users");
    assert.equal(body.run.auditId, "audit-report");
    assert.equal(body.report.lastStatus, "succeeded");

    const runs = await fetch(`${origin}/api/admin/reports/${created.report.id}/runs?limit=5`);
    assert.equal(runs.status, 200);
    const history = (await runs.json()) as { runs: ReportRun[] };
    assert.equal(history.runs.length, 1);
    assert.equal(history.runs[0]?.id, body.run.id);

    const detail = await fetch(`${origin}/api/admin/reports/${created.report.id}`);
    assert.equal(detail.status, 200);
    const payload = (await detail.json()) as { report: ScheduledReport; runs: ReportRun[] };
    assert.equal(payload.runs.length, 1);
    assert.ok(payload.report.lastRunAt);
  });

  it("更新周期与启停状态,停用后不再排期", async () => {
    const created = (await (await createReport({})).json()) as { report: ScheduledReport };
    const response = await fetch(`${origin}/api/admin/reports/${created.report.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "周报",
        question: "本周渠道权重",
        frequency: "weekly",
        time: "08:30",
        weekday: 1,
        enabled: true,
      }),
    });
    assert.equal(response.status, 200);
    const updated = (await response.json()) as { report: ScheduledReport };
    assert.deepEqual(updated.report.schedule, { frequency: "weekly", time: "08:30", weekday: 1 });
    assert.equal(updated.report.name, "周报");
    assert.ok(updated.report.nextRunAt);

    const disabled = await fetch(`${origin}/api/admin/reports/${created.report.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(disabled.status, 200);
    const paused = (await disabled.json()) as { report: ScheduledReport };
    assert.equal(paused.report.enabled, false);
    assert.equal(paused.report.nextRunAt, null);
    assert.deepEqual(paused.report.schedule, { frequency: "weekly", time: "08:30", weekday: 1 });
  });

  it("删除报表后详情与运行接口都返回 404", async () => {
    const created = (await (await createReport({})).json()) as { report: ScheduledReport };
    await fetch(`${origin}/api/admin/reports/${created.report.id}/run`, { method: "POST" });
    const removed = await fetch(`${origin}/api/admin/reports/${created.report.id}`, {
      method: "DELETE",
    });
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { ok: true });

    assert.equal((await fetch(`${origin}/api/admin/reports/${created.report.id}`)).status, 404);
    assert.equal(
      (await fetch(`${origin}/api/admin/reports/${created.report.id}/runs`)).status,
      404,
    );
    assert.equal(
      (await fetch(`${origin}/api/admin/reports/missing-id/run`, { method: "POST" })).status,
      404,
    );
  });

  it("按 workspace 隔离,其他空间看不到也不可运行", async () => {
    const created = (await (await createReport({}, "default")).json()) as {
      report: ScheduledReport;
    };
    const workspaceResponse = await fetch(`${origin}/api/admin/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "财务部" }),
    });
    assert.equal(workspaceResponse.status, 201);
    const { workspace } = (await workspaceResponse.json()) as { workspace: { id: string } };

    const scoped = await fetch(`${origin}/api/admin/reports`, {
      headers: { "x-workspace-id": workspace.id },
    });
    assert.equal(scoped.status, 200);
    const scopedBody = (await scoped.json()) as { reports: ScheduledReport[] };
    assert.equal(scopedBody.reports.length, 0);

    const foreign = await fetch(`${origin}/api/admin/reports/${created.report.id}`, {
      headers: { "x-workspace-id": workspace.id },
    });
    assert.equal(foreign.status, 404);

    const all = await fetch(`${origin}/api/admin/reports?workspaceId=*`);
    const allBody = (await all.json()) as { reports: ScheduledReport[] };
    assert.ok(allBody.reports.some((item) => item.id === created.report.id));
  });
});
