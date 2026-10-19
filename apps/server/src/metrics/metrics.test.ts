import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { closeDb, openDb } from "../db.js";
import { MetricCaliberSchema, renderCaliberExpression } from "./caliber.js";
import { renderMetricPromptBlock, selectMetrics } from "./select.js";
import {
  createMetricDefinition,
  deleteMetricDefinition,
  getMetricDefinition,
  listMetricDefinitions,
  updateMetricDefinition,
} from "./store.js";

describe("metric caliber schema", () => {
  it("renders structured aggregations into SQL fragments", () => {
    assert.equal(
      renderCaliberExpression(MetricCaliberSchema.parse({ aggregation: "sum", measure: "amount" })),
      "SUM(amount)",
    );
    assert.equal(
      renderCaliberExpression(MetricCaliberSchema.parse({ aggregation: "count_distinct", measure: "user_id" })),
      "COUNT(DISTINCT user_id)",
    );
    assert.equal(
      renderCaliberExpression(MetricCaliberSchema.parse({ aggregation: "count" })),
      "COUNT(*)",
    );
  });

  it("prefers explicit expression and rejects incomplete calibers", () => {
    assert.equal(
      renderCaliberExpression(
        MetricCaliberSchema.parse({ aggregation: "expression", expression: "SUM(amount) FILTER (WHERE x)" }),
      ),
      "SUM(amount) FILTER (WHERE x)",
    );
    assert.throws(() => MetricCaliberSchema.parse({ aggregation: "sum" }), /measure/);
    assert.throws(() => MetricCaliberSchema.parse({ aggregation: "expression" }), /expression/);
  });
});

describe("metric definition store", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "open-agent-tools-metrics-"));
    process.env.SQLITE_PATH = join(dir, "test.sqlite");
    closeDb();
    openDb();
  });

  afterEach(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SQLITE_PATH;
  });

  it("creates, reads, lists and updates metric definitions", () => {
    const created = createMetricDefinition({
      name: "差旅费总额",
      description: "已审批的差旅报销合计",
      category: "费用",
      unit: "元",
      caliber: {
        aggregation: "sum",
        measure: "amount",
        filters: [{ field: "status", operator: "=", value: "APPROVED" }],
        timeField: "approve_date",
        dimensions: ["department", "expense_type"],
        notes: "仅统计已审批单据",
      },
      tables: ["expense_reports"],
      synonyms: ["差旅报销", "出差费用"],
      tags: ["finance"],
    });
    assert.equal(created.status, "active");
    assert.equal(created.version, 1);
    assert.deepEqual(created.synonyms, ["差旅报销", "出差费用"]);
    assert.equal(created.caliber.filters[0]?.value, "APPROVED");

    assert.equal(getMetricDefinition(created.id)?.name, "差旅费总额");
    assert.equal(listMetricDefinitions({ category: "费用" }).length, 1);
    assert.equal(listMetricDefinitions({ status: "draft" }).length, 0);

    const updated = updateMetricDefinition(created.id, {
      unit: "万元",
      status: "draft",
    });
    assert.equal(updated?.version, 2);
    assert.equal(updated?.unit, "万元");
    assert.equal(updated?.status, "draft");
    assert.equal(updated?.name, "差旅费总额");

    assert.equal(deleteMetricDefinition(created.id), true);
    assert.equal(getMetricDefinition(created.id), null);
    assert.equal(deleteMetricDefinition(created.id), false);
  });

  it("rejects invalid input", () => {
    assert.throws(() => createMetricDefinition({ name: "  ", caliber: { aggregation: "count" } }), /name/);
    assert.throws(
      () => createMetricDefinition({ name: "x", caliber: { aggregation: "sum" } }),
      /measure/,
    );
  });
});

describe("metric selection", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "open-agent-tools-metrics-select-"));
    process.env.SQLITE_PATH = join(dir, "test.sqlite");
    closeDb();
    openDb();
    createMetricDefinition({
      name: "差旅费总额",
      category: "费用",
      unit: "元",
      caliber: {
        aggregation: "sum",
        measure: "amount",
        filters: [{ field: "status", operator: "=", value: "APPROVED" }],
        timeField: "approve_date",
        dimensions: ["department"],
        notes: "仅统计已审批单据",
      },
      tables: ["expense_reports"],
      synonyms: ["差旅报销", "出差费用"],
    });
    createMetricDefinition({
      name: "活跃用户数",
      category: "增长",
      caliber: { aggregation: "count_distinct", measure: "user_id", timeField: "login_at" },
      synonyms: ["DAU"],
    });
  });

  afterEach(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SQLITE_PATH;
  });

  it("ranks metrics by keyword and synonym hits", () => {
    const matches = selectMetrics("帮我看看上个月的差旅报销总额");
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.metric.name, "差旅费总额");
    assert.ok(matches[0]!.matchedTerms.includes("差旅报销"));
  });

  it("renders a prompt block with caliber details", () => {
    const matches = selectMetrics("这个月的 DAU 是多少");
    const block = renderMetricPromptBlock(matches);
    assert.match(block, /指标口径字典/);
    assert.match(block, /活跃用户数/);
    assert.match(block, /COUNT\(DISTINCT user_id\)/);
  });

  it("returns empty results for unrelated questions", () => {
    assert.deepEqual(selectMetrics("今天天气怎么样"), []);
    assert.equal(renderMetricPromptBlock([]), "");
  });
});
