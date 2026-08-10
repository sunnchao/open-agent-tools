import type { ExpenseEnum, ResolverResult } from "../types.js";

const SYNONYMS: Record<ExpenseEnum, string[]> = {
  TRAVEL: ["差旅报销", "差旅费", "差旅", "出差", "交通费", "住宿"],
  MEAL: ["餐饮", "餐费", "吃饭", "用餐", "伙食"],
  ENTERTAIN: ["招待", "商务接待", "业务招待", "接待"],
  ALL: ["费用", "报销", "所有费用"],
};
// 优先级：具体类型优先于 ALL
const PRIORITY: ExpenseEnum[] = ["TRAVEL", "MEAL", "ENTERTAIN", "ALL"];

/**
 * 费用类型解析：同义词 → enum。
 * 未提供默认 TRAVEL（差旅场景约定）；多义时取优先级最高的并标记 ambiguous。
 */
export function resolveExpense(raw: string | undefined, fallback: ExpenseEnum = "TRAVEL"): ResolverResult<ExpenseEnum> {
  if (!raw) {
    return { value: fallback, candidates: [], ambiguous: false, missing: false, note: `未提供费用类型，默认 ${fallback}` };
  }

  const matched = PRIORITY.filter((e) => SYNONYMS[e].some((s) => raw.includes(s)));
  if (matched.length === 0) {
    return { value: fallback, candidates: [], ambiguous: false, missing: false, note: `未匹配费用类型，默认 ${fallback}` };
  }

  const value = matched[0]!;
  const ambiguous = matched.length > 1 && value !== "ALL";
  return {
    value,
    candidates: matched.map((e) => ({ label: e, value: e, score: 1 })),
    ambiguous,
    missing: false,
    note: ambiguous ? `多义，取首选 ${value}` : `命中 ${value}`,
  };
}
