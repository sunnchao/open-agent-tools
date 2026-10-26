import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import test from "node:test";
import express from "express";
import { parseQualityReportDays, analyticsRouter } from "./analytics.js";

async function startServer(report: (days: 7 | 30) => unknown) {
  const app = express();
  app.use(
    "/api/analytics",
    analyticsRouter({
      analytics: {
        qualityReport: report as never,
        overview: () => ({}) as never,
      },
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Server) {
  server.close();
  await once(server, "close");
}

test("quality report API defaults to 7 days and accepts 30 days", async () => {
  const requested: number[] = [];
  const { server, origin } = await startServer((days) => {
    requested.push(days);
    return { periodDays: days };
  });
  try {
    const seven = await fetch(`${origin}/api/analytics/quality-report`);
    assert.equal(seven.status, 200);
    assert.deepEqual(await seven.json(), { periodDays: 7 });
    const thirty = await fetch(`${origin}/api/analytics/quality-report?days=30`);
    assert.equal(thirty.status, 200);
    assert.deepEqual(await thirty.json(), { periodDays: 30 });
    assert.deepEqual(requested, [7, 30]);
  } finally {
    await closeServer(server);
  }
});

test("quality report API rejects unsupported windows", async () => {
  const { server, origin } = await startServer(() => ({ periodDays: 7 }));
  try {
    for (const value of ["14", "0", "abc", "7.5"]) {
      const response = await fetch(`${origin}/api/analytics/quality-report?days=${value}`);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "days must be 7 or 30" });
    }
  } finally {
    await closeServer(server);
  }
  assert.equal(parseQualityReportDays("30.0"), 30);
  assert.throws(() => parseQualityReportDays("30.5"), /7 or 30/);
});
