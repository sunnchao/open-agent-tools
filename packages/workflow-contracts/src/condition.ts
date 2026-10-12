import { z } from "zod";
import { referenceRoot, valuePath } from "./paths.js";

export const conditionOperatorSchema = z.enum([
  "contains",
  "not_contains",
  "start_with",
  "end_with",
  "is",
  "is_not",
  "is_empty",
  "is_not_empty",
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
]);
export type ConditionOperator = z.infer<typeof conditionOperatorSchema>;
export type ConditionValueType = "any" | "string" | "number" | "boolean" | "object" | "array";
export const conditionRuleSchema = z.object({
  variable: z.string().max(500),
  operator: conditionOperatorSchema,
  value: z.unknown().optional(),
});
export const conditionCaseSchema = z.object({
  id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,200}$/)
    .refine((id) => id !== "else", "else is reserved"),
  logicalOperator: z.enum(["and", "or"]).optional(),
  rules: z.array(conditionRuleSchema).max(256),
});
export type ConditionRule = z.infer<typeof conditionRuleSchema>;
export type ConditionCase = z.infer<typeof conditionCaseSchema>;
export interface ConditionWarning {
  caseId: string;
  caseLabel?: string;
  ruleIndex: number;
  operator: ConditionOperator;
  message: string;
}
export const conditionFields = {
  mode: z.enum(["visual", "expression"]).optional(),
  expression: z.string().optional(),
  cases: z.array(conditionCaseSchema).max(64).optional(),
};

export function isVisualCondition(config: Record<string, unknown> = {}): boolean {
  return (
    config.mode !== "expression" && (config.mode === "visual" || Object.hasOwn(config, "cases"))
  );
}
export function conditionCases(config: Record<string, unknown>): ConditionCase[] {
  return Array.isArray(config.cases) ? (config.cases as ConditionCase[]) : [];
}
export function conditionReference(variable: string): string {
  return variable
    .trim()
    .replace(/^\{\{\s*([^{}]*?)\s*\}\}$/, "$1")
    .trim();
}
export function conditionNeedsValue(operator: ConditionOperator): boolean {
  return operator !== "is_empty" && operator !== "is_not_empty";
}
export const conditionOperators: Array<{
  value: ConditionOperator;
  label: string;
  types: ConditionValueType[];
}> = [
  { value: "contains", label: "包含", types: ["string", "array"] },
  { value: "not_contains", label: "不包含", types: ["string", "array"] },
  { value: "start_with", label: "开头是", types: ["string"] },
  { value: "end_with", label: "结尾是", types: ["string"] },
  { value: "is", label: "是", types: ["string", "number", "boolean"] },
  { value: "is_not", label: "不是", types: ["string", "number", "boolean"] },
  { value: "eq", label: "等于", types: ["string", "number", "boolean"] },
  { value: "neq", label: "不等于", types: ["string", "number", "boolean"] },
  { value: "gt", label: "大于", types: ["number"] },
  { value: "gte", label: "大于等于", types: ["number"] },
  { value: "lt", label: "小于", types: ["number"] },
  { value: "lte", label: "小于等于", types: ["number"] },
  { value: "is_empty", label: "为空", types: ["string", "number", "boolean", "object", "array"] },
  {
    value: "is_not_empty",
    label: "不为空",
    types: ["string", "number", "boolean", "object", "array"],
  },
];
export function operatorsForType(type: ConditionValueType) {
  return conditionOperators.filter((operator) => type === "any" || operator.types.includes(type));
}
export function conditionBranchLabel(config: Record<string, unknown>, branchId: string): string {
  if (branchId === "else" || (!isVisualCondition(config) && branchId === "false")) return "ELSE";
  if (!isVisualCondition(config)) return branchId === "true" ? "IF" : "默认";
  const index = conditionCases(config).findIndex((item) => item.id === branchId);
  return index < 0 ? "已失效分支" : `CASE ${index + 1} · ${index === 0 ? "IF" : "ELIF"}`;
}
export interface ConditionIssue {
  code: string;
  message: string;
  caseId?: string;
  ruleIndex?: number;
  reference?: string;
  field?: string;
}
export function conditionConfigIssues(
  config: Record<string, unknown>,
  inputs: Map<string, ConditionValueType> = new Map(),
): ConditionIssue[] {
  if (!isVisualCondition(config)) return [];
  const parsed = z.object(conditionFields).safeParse(config);
  if (!parsed.success)
    return parsed.error.issues.map((issue) => ({
      code: "condition-schema",
      message: `条件配置 ${issue.path.join(".")} 无效：${issue.message}`,
    }));
  const issues: ConditionIssue[] = [];
  const cases = parsed.data.cases ?? [];
  if (!cases.length) return [{ code: "condition-empty", message: "请至少配置一个 IF 分支" }];
  const ids = new Set<string>();
  for (const [caseIndex, item] of cases.entries()) {
    const prefix = `CASE ${caseIndex + 1}`;
    if (ids.has(item.id))
      issues.push({ code: "condition-case-id", message: `${prefix} 分支 ID 重复` });
    ids.add(item.id);
    if (!item.rules.length)
      issues.push({ code: "condition-empty", message: `${prefix} 请添加条件`, caseId: item.id });
    for (const [ruleIndex, rule] of item.rules.entries()) {
      const details = { caseId: item.id, ruleIndex };
      const reference = conditionReference(rule.variable);
      const path = valuePath(reference);
      if (!path || !inputs.has(referenceRoot(reference))) {
        issues.push({
          code: "condition-reference",
          message: `${prefix} 条件 ${ruleIndex + 1} 请选择有效变量`,
          reference,
          field: "cases",
          ...details,
        });
      }
      const type = path?.length === 1 ? (inputs.get(path[0]!) ?? "any") : "any";
      if (!operatorsForType(type).some((operator) => operator.value === rule.operator))
        issues.push({
          code: "condition-type",
          message: `${prefix} 条件 ${ruleIndex + 1} 运算符不适用于 ${type}`,
          ...details,
        });
      if (conditionNeedsValue(rule.operator) && !Object.hasOwn(rule, "value"))
        issues.push({
          code: "condition-value",
          message: `${prefix} 条件 ${ruleIndex + 1} 请填写比较值`,
          ...details,
        });
      else if (
        conditionNeedsValue(rule.operator) &&
        type !== "any" &&
        !(typeof rule.value === "string" && /\{\{/.test(rule.value))
      ) {
        const scalar =
          rule.value === null || ["string", "number", "boolean"].includes(typeof rule.value);
        const expected = type === "array" ? scalar : typeof rule.value === type;
        if (!expected || (typeof rule.value === "number" && !Number.isFinite(rule.value)))
          issues.push({
            code: "condition-value-type",
            message: `${prefix} 条件 ${ruleIndex + 1} 比较值类型不匹配`,
            ...details,
          });
      }
    }
  }
  return issues;
}

export function conditionRouteIssues(
  config: Record<string, unknown>,
  edges: Array<{ branchId?: string; label?: unknown }>,
): ConditionIssue[] {
  if (!isVisualCondition(config))
    return edges.some((edge) => edge.branchId !== undefined)
      ? [{ code: "condition-routes", message: "表达式模式不能使用可视化分支连接" }]
      : [];
  const branches = [...conditionCases(config).map((item) => item.id), "else"];
  const issues: ConditionIssue[] = [];
  for (const edge of edges)
    if (!edge.branchId || !branches.includes(edge.branchId) || edge.label !== undefined)
      issues.push({ code: "condition-routes", message: "连接引用了无效的条件分支" });
  for (const branchId of branches)
    if (!edges.some((edge) => edge.branchId === branchId))
      issues.push({
        code: "condition-routes",
        message: `${conditionBranchLabel(config, branchId)} 请选择下一节点`,
        caseId: branchId,
      });
  return issues;
}

export function selectedConditionEdges<T extends { branchId?: string; label?: unknown }>(
  config: Record<string, unknown>,
  result: unknown,
  edges: T[],
): T[] {
  if (isVisualCondition(config)) {
    const ids = [...conditionCases(config).map((item) => item.id), "else"];
    if (typeof result !== "string" || !ids.includes(result))
      throw new Error("条件节点缓存不完整，请先完整运行");
    return edges.filter((edge) => edge.branchId === result);
  }
  if (typeof result !== "boolean") throw new Error("条件节点缓存不完整，请先完整运行");
  const selected = edges.filter((edge) => edge.label === String(result));
  return selected.length ? selected : edges.filter((edge) => !edge.label);
}
