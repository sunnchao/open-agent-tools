import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createApp } from "../app.js";
import { closeDb } from "../db.js";

let server: Server;
let origin: string;
let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "metric-api-test-"));
  process.env.SQLITE_PATH = join(dir, "test.sqlite");
  server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  server.close();
  await once(server, "close");
  closeDb();
  delete process.env.SQLITE_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe("metric dictionary API", () => {
  let metricId = "";

  it("creates a metric definition via admin API", async () => {
    const response = await fetch(`${origin}/api/admin/metrics`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "差旅费总额",
        category: "费用",
        unit: "元",
        caliber: {
          aggregation: "sum",
          measure: "amount",
          filters: [{ field: "status", operator: "=", value: "APPROVED" }],
          timeField: "approve_date",
        },
        synonyms: ["差旅报销"],
        tables: ["expense_reports"],
      }),
    });
    assert.equal(response.status, 201);
    const created = (await response.json()) as { metric: { id: string; status: string; version: number } };
    metricId = created.metric.id;
    assert.equal(created.metric.status, "active");
    assert.equal(created.metric.version, 1);
  });

  it("rejects invalid caliber payloads with 400", async () => {
    const response = await fetch(`${origin}/api/admin/metrics`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "坏指标", caliber: { aggregation: "sum" } }),
    });
    assert.equal(response.status, 400);
  });

  it("lists active metrics and returns 404 for missing ids", async () => {
    const list = await fetch(`${origin}/api/metrics`);
    assert.equal(list.status, 200);
    const payload = (await list.json()) as { metrics: Array<{ id: string }> };
    assert.ok(payload.metrics.some((metric) => metric.id === metricId));

    const missing = await fetch(`${origin}/api/admin/metrics/does-not-exist`);
    assert.equal(missing.status, 404);
  });

  it("updates and deletes a metric", async () => {
    const updated = await fetch(`${origin}/api/admin/metrics/${metricId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ unit: "万元" }),
    });
    assert.equal(updated.status, 200);
    const updatedPayload = (await updated.json()) as { metric: { unit: string; version: number } };
    assert.equal(updatedPayload.metric.unit, "万元");
    assert.equal(updatedPayload.metric.version, 2);

    const removed = await fetch(`${origin}/api/admin/metrics/${metricId}`, { method: "DELETE" });
    assert.equal(removed.status, 204);
  });

  it("matches metrics against a question with prompt block", async () => {
    await fetch(`${origin}/api/admin/metrics`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "活跃用户数",
        caliber: { aggregation: "count_distinct", measure: "user_id" },
        synonyms: ["DAU"],
      }),
    });
    const response = await fetch(`${origin}/api/metrics/match`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "今天的 DAU 是多少" }),
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      matches: Array<{ metric: { name: string } }>;
      prompt: string;
    };
    assert.equal(payload.matches[0]?.metric.name, "活跃用户数");
    assert.match(payload.prompt, /COUNT\(DISTINCT user_id\)/);

    const invalid = await fetch(`${origin}/api/metrics/match`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "" }),
    });
    assert.equal(invalid.status, 400);
  });
});
