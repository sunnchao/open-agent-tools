import {
  conditionReference,
  conditionNeedsValue,
  valuePath,
  type ConditionCase,
  type ConditionOperator,
  type ConditionWarning,
} from "@open-agent-tools/workflow-contracts";

function resolve(reference: string, inputs: Record<string, unknown>): unknown {
  const path = valuePath(conditionReference(reference));
  if (!path || !Object.hasOwn(inputs, path[0]!)) throw new Error("条件引用了无效或未绑定的变量");
  let value: unknown = inputs;
  for (const key of path) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function hydrate(value: unknown, inputs: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const exact = value.match(/^\{\{\s*([^{}]*?)\s*\}\}$/);
    if (exact) return resolve(exact[1]!, inputs);
    return value.replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (_match, name: string) => {
      const resolved = resolve(name, inputs);
      return typeof resolved === "string" ? resolved : (JSON.stringify(resolved) ?? "");
    });
  }
  if (Array.isArray(value)) return value.map((item) => hydrate(item, inputs));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, hydrate(item, inputs)]),
    );
  return value;
}
function empty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return !value.trim();
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && Object.keys(value).length === 0;
}
function scalar(value: unknown): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}
function compare(left: unknown, right: unknown, operator: ConditionOperator): boolean | undefined {
  if (operator === "is_empty") return empty(left);
  if (operator === "is_not_empty") return !empty(left);
  if (left === undefined || right === undefined) return undefined;
  if (operator === "contains" || operator === "not_contains") {
    let matched: boolean;
    if (typeof left === "string" && typeof right === "string") matched = left.includes(right);
    else if (Array.isArray(left) && scalar(right))
      matched = left.some((item) => Object.is(item, right));
    else return undefined;
    return operator === "contains" ? matched : !matched;
  }
  if (operator === "start_with" || operator === "end_with") {
    if (typeof left !== "string" || typeof right !== "string") return undefined;
    return operator === "start_with" ? left.startsWith(right) : left.endsWith(right);
  }
  if (["is", "is_not", "eq", "neq"].includes(operator)) {
    if (
      !scalar(left) ||
      !scalar(right) ||
      typeof left !== typeof right ||
      (typeof left === "number" && (!Number.isFinite(left) || !Number.isFinite(right)))
    )
      return undefined;
    const equal = Object.is(left, right);
    return operator === "is_not" || operator === "neq" ? !equal : equal;
  }
  if (
    typeof left !== "number" ||
    typeof right !== "number" ||
    !Number.isFinite(left) ||
    !Number.isFinite(right)
  )
    return undefined;
  if (operator === "gt") return left > right;
  if (operator === "gte") return left >= right;
  if (operator === "lt") return left < right;
  if (operator === "lte") return left <= right;
  throw new Error("未知条件运算符");
}
export function evaluateConditionCases(
  cases: ConditionCase[],
  inputs: Record<string, unknown>,
): { result: string; warnings: ConditionWarning[] } {
  if (!cases.length || cases.some((item) => !item.rules.length))
    throw new Error("请完成 IF/ELIF 条件配置");
  const warnings: ConditionWarning[] = [];
  for (const [caseIndex, item] of cases.entries()) {
    const ruleMatches = (rule: ConditionCase["rules"][number], ruleIndex: number): boolean => {
      if (conditionNeedsValue(rule.operator) && !Object.hasOwn(rule, "value"))
        throw new Error("条件缺少比较值");
      const left = resolve(rule.variable, inputs);
      const right = conditionNeedsValue(rule.operator) ? hydrate(rule.value, inputs) : undefined;
      const result = compare(left, right, rule.operator);
      if (result === undefined && warnings.length < 50)
        warnings.push({
          caseId: item.id,
          caseLabel: `CASE ${caseIndex + 1} · ${caseIndex === 0 ? "IF" : "ELIF"}`,
          ruleIndex,
          operator: rule.operator,
          message: "变量缺省或比较值类型不匹配，该条件按不满足处理",
        });
      return result === true;
    };
    const matched =
      item.logicalOperator === "or" ? item.rules.some(ruleMatches) : item.rules.every(ruleMatches);
    if (matched) return { result: item.id, warnings };
  }
  return { result: "else", warnings };
}
