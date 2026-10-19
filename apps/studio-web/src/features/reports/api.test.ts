import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createReport,
  deleteReport,
  getReport,
  listReports,
  listReportRuns,
  listSchemaSources,
  runReportNow,
  updateReport,
  type ReportDraft,
  type ReportRun,
  type ScheduledReport,
} from "./api.js";

afterEach(() => vi.unstubAllGlobals());

const dailyDraft: ReportDraft = {
  name: "每日活跃用户",
  question: "昨天的活跃用户有多少?",
  sourceId: null,
  frequency: "daily",
  time: "09:00",
  weekday: 1,
  enabled: true,
};

const report = {
  id: "report-1",
  workspace: "default",
  name: "每日活跃用户",
  question: "昨天的活跃用户有多少?",
  sourceId: null,
  schedule: { frequency: "daily", time: "09:00" },
  enabled: true,
  nextRunAt: "2026-10-20T09:00:00.000Z",
  lastRunAt: null,
  lastStatus: null,
  createdAt: "2026-10-19T00:00:00.000Z",
  updatedAt: "2026-10-19T00:00:00.000Z",
} satisfies ScheduledReport;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("reports api", () => {
  it("loads the report list from the admin group", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ reports: [report] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(listReports()).resolves.toEqual({ reports: [report] });
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/reports", undefined);
  });

  it("creates a daily report without weekday in the payload", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ report }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createReport(dailyDraft)).resolves.toEqual({ report });
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: dailyDraft.name,
        question: dailyDraft.question,
        sourceId: null,
        frequency: "daily",
        time: "09:00",
        enabled: true,
      }),
    });
  });

  it("sends weekday for weekly schedules and encodes report ids", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ report }));
    vi.stubGlobal("fetch", fetchMock);
    await updateReport("report/1", {
      ...dailyDraft,
      frequency: "weekly",
      time: "08:30",
      weekday: 3,
      enabled: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/reports/report%2F1",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          name: dailyDraft.name,
          question: dailyDraft.question,
          sourceId: null,
          frequency: "weekly",
          time: "08:30",
          weekday: 3,
          enabled: false,
        }),
      }),
    );
  });

  it("loads report detail, runs, and runs history with a limit", async () => {
    const run = { id: "run-1", reportId: "report-1" } as unknown as ReportRun;
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("/runs")
        ? jsonResponse({ runs: [run] })
        : jsonResponse({ report, runs: [run] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(getReport("report-1")).resolves.toEqual({ report, runs: [run] });
    await expect(listReportRuns("report-1", 5)).resolves.toEqual({ runs: [run] });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/admin/reports/report-1",
      "/api/admin/reports/report-1/runs?limit=5",
    ]);
  });

  it("runs once and deletes through dedicated endpoints", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ ok: true, run: {}, report }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await runReportNow("report-1");
    await deleteReport("report-1");
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ["/api/admin/reports/report-1/run", "POST"],
      ["/api/admin/reports/report-1", "DELETE"],
    ]);
  });

  it("surfaces server errors and unwraps schema sources", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: "weekly 周期必须提供 weekday(0=周日 .. 6=周六)" }, 400),
      ),
    );
    await expect(createReport(dailyDraft)).rejects.toThrow("weekly 周期必须提供 weekday");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ sources: [{ id: "ops", name: "运营库", isDefault: true }] })),
    );
    await expect(listSchemaSources()).resolves.toEqual([
      { id: "ops", name: "运营库", isDefault: true },
    ]);
  });
});
