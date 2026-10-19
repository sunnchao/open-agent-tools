import type { ApprovalStatus, ResolverResult } from "../types.js";

const MAP: { status: ApprovalStatus; keys: string[] }[] = [
  { status: "APPROVED", keys: ["已通过", "已审批", "审批通过", "通过"] },
  { status: "REJECTED", keys: ["已驳回", "驳回", "被拒", "拒绝"] },
  { status: "PENDING", keys: ["审批中", "待审批", "待审核", "pending"] },
];

/** 可配置口径的审批状态关键词：value 命中任一 word 即解析为该状态 */
export interface StatusWordPattern {
  value: ApprovalStatus;
  words: string[];
}

/** 审批状态解析。未提供默认 APPROVED。patterns 提供时按配置词表解析。 */
export function resolveStatus(
  raw: string | undefined,
  fallback: ApprovalStatus = "APPROVED",
  patterns?: StatusWordPattern[],
): ResolverResult<ApprovalStatus> {
  if (!raw) {
    return { value: fallback, candidates: [], ambiguous: false, missing: false, note: `未提供状态，默认 ${fallback}` };
  }
  const rules = patterns?.length ? patterns : MAP.map((m) => ({ value: m.status, words: m.keys }));
  for (const m of rules) {
    if (m.words.some((k) => raw.includes(k))) {
      return {
        value: m.value,
        candidates: [{ label: m.value, value: m.value, score: 1 }],
        ambiguous: false,
        missing: false,
        note: `命中 ${m.value}`,
      };
    }
  }
  return { value: fallback, candidates: [], ambiguous: false, missing: false, note: `未匹配状态，默认 ${fallback}` };
}
