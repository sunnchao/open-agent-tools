import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChartSuggestion } from "./chartSuggest.js";

test("时间维度 + 数值列 → line（趋势）", () => {
  const chart = buildChartSuggestion(
    [
      { key: "月份", title: "月份" },
      { key: "合同金额", title: "合同金额" },
    ],
    [
      { 月份: "2026-01", 合同金额: 10 },
      { 月份: "2026-02", 合同金额: 20 },
      { 月份: "2026-03", 合同金额: 15 },
    ],
  );
  assert.deepEqual(chart, {
    type: "line",
    x: "月份",
    series: ["合同金额"],
    reason: "按“月份”展示趋势",
  });
});

test("少类别 + 单数值列 → pie（占比）", () => {
  const chart = buildChartSuggestion(
    [
      { key: "合同状态", title: "合同状态" },
      { key: "数量", title: "数量" },
    ],
    [
      { 合同状态: "草稿", 数量: 3 },
      { 合同状态: "生效", 数量: 8 },
      { 合同状态: "作废", 数量: 1 },
    ],
  );
  assert.equal(chart?.type, "pie");
  assert.equal(chart?.x, "合同状态");
  assert.deepEqual(chart?.series, ["数量"]);
});

test("中类别 + 多数值列 → bar，并优先非 ID 维度", () => {
  const chart = buildChartSuggestion(
    [
      { key: "合同编号", title: "合同编号" },
      { key: "类型", title: "类型" },
      { key: "金额", title: "金额" },
      { key: "数量", title: "数量" },
    ],
    [
      { 合同编号: "HT-1", 类型: "采购", 金额: 10, 数量: 1 },
      { 合同编号: "HT-2", 类型: "销售", 金额: 20, 数量: 2 },
      { 合同编号: "HT-3", 类型: "采购", 金额: 30, 数量: 3 },
    ],
  );
  assert.equal(chart?.type, "bar");
  assert.equal(chart?.x, "类型");
  assert.deepEqual(chart?.series, ["金额", "数量"]);
});

test("无数值列 / 单行 / 类别过多 → null（回退表格）", () => {
  assert.equal(
    buildChartSuggestion(
      [
        { key: "a", title: "a" },
        { key: "b", title: "b" },
      ],
      [
        { a: "x", b: "y" },
        { a: "z", b: "w" },
      ],
    ),
    null,
  );
  assert.equal(buildChartSuggestion([{ key: "a", title: "a" }, { key: "b", title: "b" }], [{ a: "x", b: 1 }]), null);
  assert.equal(
    buildChartSuggestion(
      [
        { key: "订单号", title: "订单号" },
        { key: "金额", title: "金额" },
      ],
      Array.from({ length: 20 }, (_value, index) => ({ 订单号: `NO-${index}`, 金额: index })),
    ),
    null,
  );
});

test("字符串数值列也可识别为指标", () => {
  const chart = buildChartSuggestion(
    [
      { key: "state", title: "state" },
      { key: "total", title: "total" },
    ],
    [
      { state: "a", total: "10" },
      { state: "b", total: "20" },
    ],
  );
  assert.equal(chart?.type, "pie");
  assert.deepEqual(chart?.series, ["total"]);
});
