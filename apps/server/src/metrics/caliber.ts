import { z } from "zod";

/** 指标聚合方式：口径的数值计算语义。expression 表示依赖 expression 字段自定义。 */
export const MetricAggregationSchema = z.enum([
  "sum",
  "count",
  "count_distinct",
  "avg",
  "min",
  "max",
  "expression",
]);

/** 口径过滤条件：字段 + 运算符 + 值；值允许字符串/数字/布尔或字符串数组。 */
export const MetricFilterSchema = z.object({
  field: z.string().min(1),
  operator: z
    .enum(["=", "!=", ">", ">=", "<", "<=", "in", "not in", "like", "is null", "is not null"])
    .default("="),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
});

/**
 * 业务口径（MetricCaliber）：可复用的指标定义。
 * 既支持结构化描述（聚合 + 字段 + 过滤），也支持直接给定 SQL 表达式/片段。
 */
export const MetricCaliberSchema = z
  .object({
    aggregation: MetricAggregationSchema.default("sum"),
    /** 度量字段或 SQL 表达式；aggregation=expression 时必填。 */
    measure: z.string().min(1).optional(),
    /** 完整口径 SQL 片段（SELECT 聚合部分），优先级高于结构化字段。 */
    expression: z.string().min(1).optional(),
    /** 口径限定条件（如 status = 'APPROVED'）。 */
    filters: z.array(MetricFilterSchema).default([]),
    /** 时间字段，用于趋势/时间范围过滤。 */
    timeField: z.string().min(1).optional(),
    /** 可下钻维度。 */
    dimensions: z.array(z.string().min(1)).default([]),
    /** 口径说明/注意事项，供 LLM 理解业务语义。 */
    notes: z.string().optional(),
  })
  .superRefine((caliber, ctx) => {
    if (caliber.aggregation === "expression" && !caliber.expression) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "aggregation=expression 时必须提供 expression",
        path: ["expression"],
      });
    }
    if (caliber.aggregation !== "count" && caliber.aggregation !== "expression" && !caliber.measure) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `aggregation=${caliber.aggregation} 时必须提供 measure`,
        path: ["measure"],
      });
    }
  });

export type MetricAggregation = z.infer<typeof MetricAggregationSchema>;
export type MetricFilter = z.infer<typeof MetricFilterSchema>;
export type MetricCaliber = z.infer<typeof MetricCaliberSchema>;
export type MetricCaliberInput = z.input<typeof MetricCaliberSchema>;

export const METRIC_STATUSES = ["draft", "active", "deprecated"] as const;
export const MetricStatusSchema = z.enum(METRIC_STATUSES);
export type MetricStatus = z.infer<typeof MetricStatusSchema>;

/** 将口径渲染为单行 SQL 聚合片段，供 prompt 注入或人工核对。 */
export function renderCaliberExpression(caliber: MetricCaliber): string {
  if (caliber.expression) return caliber.expression;
  const measure = caliber.measure ?? "*";
  switch (caliber.aggregation) {
    case "count":
      return `COUNT(${measure})`;
    case "count_distinct":
      return `COUNT(DISTINCT ${measure})`;
    case "avg":
      return `AVG(${measure})`;
    case "min":
      return `MIN(${measure})`;
    case "max":
      return `MAX(${measure})`;
    case "sum":
      return `SUM(${measure})`;
    default:
      return measure;
  }
}
