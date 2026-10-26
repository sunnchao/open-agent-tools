/**
 * 问数结果校验(C4):在结果展示给业务方之前拦截「明显不对」的答案。
 *
 * 设计原则:
 * - 纯函数、无 IO:输入是已取回的行与可选历史基线,输出是结构化预警;
 * - 只做保守判定:没有足够信号时宁可不报,也不要把正常结果标成异常;
 * - 预警不是拦截:结果照常返回,由上层决定展示与提示方式。
 */

export type ResultCheckLevel = "info" | "warning";

export interface ResultCheck {
  code: ResultCheckCode;
  level: ResultCheckLevel;
  message: string;
  /** 受影响的列(整表级预警为空);便于前端定位。 */
  column?: string;
  /** 机器可读的明细,用于审计落库与后续阈值调参。 */
  detail?: Record<string, unknown>;
}

export type ResultCheckCode =
  | "empty_result"
  | "truncated"
  | "all_null_column"
  | "high_null_ratio"
  | "row_count_shift"
  | "magnitude_shift";

/**
 * 历史基线:同源同问题上一次成功查询的观测值。
 * 由 `resultBaselines.ts` 落库,缺失时跳过依赖基线的规则。
 */
export interface QueryResultBaseline {
  rowCount: number;
  /** 列名 → 该列非空数值的中位数。 */
  numericMedians: Record<string, number>;
  capturedAt: string;
}

export interface AssessQueryResultInput {
  rows: Record<string, unknown>[];
  /** 结果是否因展示上限被截断。 */
  truncated?: boolean;
  baseline?: QueryResultBaseline | null;
}

export interface QueryResultAssessment {
  /** 最高严重级别;无预警时为 "info"。 */
  level: ResultCheckLevel;
  checks: ResultCheck[];
}

/** 行数相对基线放大到该倍数即视为异常(需基线行数达到 MIN_BASELINE_ROWS)。 */
export const ROW_COUNT_GROWTH_FACTOR = 5;
/** 行数相对基线缩小到该比例以下即视为异常。 */
export const ROW_COUNT_SHRINK_RATIO = 0.2;
/** 基线行数小于该值时不做行数突变判断,避免小样本噪声。 */
export const MIN_BASELINE_ROWS = 20;
/** 数值列中位数相对基线的放大/缩小倍数阈值。 */
export const MAGNITUDE_GROWTH_FACTOR = 10;
export const MAGNITUDE_SHRINK_RATIO = 0.1;
/** 空值比例达到该值即提示(整列全空另有专门规则)。 */
export const HIGH_NULL_RATIO = 0.5;

function isMissing(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

/** 只接受真正的数值与可无损解析的数值字符串,避免把 id、编码当成金额。 */
function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || !/^-?\d+(?:\.\d+)?$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const left = sorted[middle - 1];
  const right = sorted[middle];
  if (left === undefined || right === undefined) return null;
  return (left + right) / 2;
}

function columnsOf(rows: Record<string, unknown>[]): string[] {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      columns.push(key);
    }
  }
  return columns;
}

/** 计算一行结果中每列非空数值的中位数,作为下一次查询的基线。 */
export function numericMediansOf(rows: Record<string, unknown>[]): Record<string, number> {
  const medians: Record<string, number> = {};
  for (const column of columnsOf(rows)) {
    const values: number[] = [];
    for (const row of rows) {
      const parsed = toNumber(row[column]);
      if (parsed !== null) values.push(parsed);
    }
    const value = median(values);
    if (value !== null) medians[column] = value;
  }
  return medians;
}

function formatRatio(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1);
}

/**
 * 对一次查询结果做规则校验。规则按「整表 → 列」顺序产出,顺序稳定便于测试。
 */
export function assessQueryResult(input: AssessQueryResultInput): QueryResultAssessment {
  const rows = input.rows ?? [];
  const checks: ResultCheck[] = [];

  if (rows.length === 0) {
    checks.push({
      code: "empty_result",
      level: "warning",
      message: "查询返回 0 行:可能是过滤条件过严或口径不包含该范围,建议核对条件后再对外展示。",
    });
  }

  if (input.truncated) {
    checks.push({
      code: "truncated",
      level: "info",
      message: "结果已按展示上限截断,当前行数并非全量,做汇总计算时需注意。",
    });
  }

  const baseline = input.baseline ?? null;
  if (baseline && baseline.rowCount >= MIN_BASELINE_ROWS && rows.length > 0) {
    const ratio = rows.length / baseline.rowCount;
    if (ratio >= ROW_COUNT_GROWTH_FACTOR || ratio <= ROW_COUNT_SHRINK_RATIO) {
      checks.push({
        code: "row_count_shift",
        level: "warning",
        message: `行数相对历史基线 ${baseline.rowCount} 行变化 ${formatRatio(ratio)} 倍,请确认为预期结果。`,
        detail: {
          rowCount: rows.length,
          baselineRowCount: baseline.rowCount,
          ratio: Number(ratio.toFixed(4)),
          baselineCapturedAt: baseline.capturedAt,
        },
      });
    }
  }

  for (const column of columnsOf(rows)) {
    let missing = 0;
    for (const row of rows) {
      if (isMissing(row[column])) missing += 1;
    }
    const ratio = rows.length > 0 ? missing / rows.length : 0;
    if (rows.length > 0 && missing === rows.length) {
      checks.push({
        code: "all_null_column",
        level: "warning",
        message: `列「${column}」全为空值,该列可能未正确聚合或字段口径有误。`,
        column,
        detail: { nullCount: missing, rowCount: rows.length },
      });
    } else if (ratio >= HIGH_NULL_RATIO) {
      checks.push({
        code: "high_null_ratio",
        level: "info",
        message: `列「${column}」空值占比 ${(ratio * 100).toFixed(0)}%,注意结论覆盖范围。`,
        column,
        detail: { nullCount: missing, rowCount: rows.length },
      });
    }
  }

  if (baseline) {
    for (const [column, baselineMedian] of Object.entries(baseline.numericMedians)) {
      if (baselineMedian === 0) continue;
      const values: number[] = [];
      for (const row of rows) {
        const parsed = toNumber(row[column]);
        if (parsed !== null) values.push(parsed);
      }
      const currentMedian = median(values);
      if (currentMedian === null) continue;
      const ratio = currentMedian / baselineMedian;
      if (ratio >= MAGNITUDE_GROWTH_FACTOR || ratio <= MAGNITUDE_SHRINK_RATIO) {
        checks.push({
          code: "magnitude_shift",
          level: "warning",
          message: `列「${column}」数值量级相对历史基线变化 ${formatRatio(ratio)} 倍,存在口径或单位变化风险。`,
          column,
          detail: {
            median: currentMedian,
            baselineMedian,
            ratio: Number(ratio.toFixed(4)),
            baselineCapturedAt: baseline.capturedAt,
          },
        });
      }
    }
  }

  return {
    level: checks.some((check) => check.level === "warning") ? "warning" : "info",
    checks,
  };
}

/** 把校验结果压成一行摘要,写入审计步骤消息。 */
export function summarizeAssessment(assessment: QueryResultAssessment): string | null {
  if (assessment.checks.length === 0) return null;
  const warnings = assessment.checks.filter((check) => check.level === "warning").length;
  const infos = assessment.checks.length - warnings;
  const parts = [warnings ? `${warnings} 项预警` : null, infos ? `${infos} 项提示` : null].filter(
    Boolean,
  );
  return `结果校验:${parts.join(" / ")}`;
}
