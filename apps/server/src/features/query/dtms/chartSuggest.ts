/**
 * 结果可视化：根据表格列/行结构，给出可直接渲染的图表建议（chart payload）。
 *
 * 纯函数、无副作用，便于在 SSE 输出与观测台复用。启发式规则：
 * - 存在时间/日期维度且类别数 ≥ 2 → 折线（趋势）
 * - 类别数少（≤ 6）且仅一个数值列 → 饼图（占比）
 * - 其余可枚举维度 → 柱状（对比）
 * - 无法推断（无数值列、单行、类别过多）→ null，前端回退到表格
 */

export type ChartType = "line" | "bar" | "pie";

export interface ChartSuggestion {
  type: ChartType;
  /** 维度列 key（图表 x 轴 / 分类轴）。 */
  x: string;
  /** 数值指标列 key 列表（y 轴 / 系列）。 */
  series: string[];
  /** 生成该建议的可读原因，便于调试与展示。 */
  reason: string;
}

export interface ChartColumn {
  key: string;
  title: string;
}

export type ChartRow = Record<string, string | number | null>;

const MAX_SERIES = 4;
const MAX_CATEGORIES = 12;
const PIE_CATEGORIES = 6;
const DATE_HINT = /日期|时间|月份|年份|年月|季度|周|星期|date|time|month|year|week|day|period/i;
const ID_HINT = /_id$|_no$|_code$|编号|代码|序号|^id$|code$/i;

function isNumeric(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string" && value.trim() !== "") return Number.isFinite(Number(value));
  return false;
}

function isNumericColumn(rows: ChartRow[], key: string): boolean {
  const values = rows
    .map((row) => row[key])
    .filter((value) => value !== null && value !== undefined && value !== "");
  return values.length > 0 && values.every(isNumeric);
}

function distinctCount(rows: ChartRow[], key: string): number {
  return new Set(rows.map((row) => row[key])).size;
}

/** 列/行 → 图表建议；无法推断时返回 null。 */
export function buildChartSuggestion(
  columns: ChartColumn[],
  rows: ChartRow[],
): ChartSuggestion | null {
  if (columns.length < 2 || rows.length < 2) return null;

  const numericKeys = columns.filter((column) => isNumericColumn(rows, column.key)).map((c) => c.key);
  if (numericKeys.length === 0) return null;
  const series = numericKeys.slice(0, MAX_SERIES);

  const dimensions = columns.filter((column) => !numericKeys.includes(column.key));
  if (dimensions.length === 0) return null;

  const temporal = dimensions.find(
    (column) =>
      (DATE_HINT.test(column.key) || DATE_HINT.test(column.title)) &&
      distinctCount(rows, column.key) >= 2,
  );
  if (temporal) {
    return { type: "line", x: temporal.key, series, reason: `按“${temporal.title}”展示趋势` };
  }

  const categorical = dimensions
    .map((column) => ({ column, distinct: distinctCount(rows, column.key) }))
    .filter((entry) => entry.distinct >= 2 && entry.distinct <= MAX_CATEGORIES)
    .sort((a, b) => {
      const aIdLike = ID_HINT.test(a.column.key) || ID_HINT.test(a.column.title) ? 1 : 0;
      const bIdLike = ID_HINT.test(b.column.key) || ID_HINT.test(b.column.title) ? 1 : 0;
      return aIdLike - bIdLike || a.distinct - b.distinct;
    })[0];
  if (!categorical) return null;

  if (categorical.distinct <= PIE_CATEGORIES && series.length === 1) {
    return {
      type: "pie",
      x: categorical.column.key,
      series,
      reason: `按“${categorical.column.title}”展示占比`,
    };
  }
  return {
    type: "bar",
    x: categorical.column.key,
    series,
    reason: `按“${categorical.column.title}”对比展示`,
  };
}
