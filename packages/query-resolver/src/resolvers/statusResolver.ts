import type { ApprovalStatus, ResolverResult } from "../types.js";

const MAP: { status: ApprovalStatus; keys: string[] }[] = [
  { status: "APPROVED", keys: ["已通过", "已审批", "审批通过", "通过"] },
  { status: "REJECTED", keys: ["已驳回", "驳回", "被拒", "拒绝"] },
  { status: "PENDING", keys: ["审批中", "待审批", "待审核", "pending"] },
];

/** 审批状态解析。未提供默认 APPROVED。 */
export function resolveStatus(raw: string | undefined, fallback: ApprovalStatus = "APPROVED"): ResolverResult<ApprovalStatus> {
  if (!raw) {
    return { value: fallback, candidates: [], ambiguous: false, missing: false, note: `未提供状态，默认 ${fallback}` };
  }
  for (const m of MAP) {
    if (m.keys.some((k) => raw.includes(k))) {
      return {
        value: m.status,
        candidates: [{ label: m.status, value: m.status, score: 1 }],
        ambiguous: false,
        missing: false,
        note: `命中 ${m.status}`,
      };
    }
  }
  return { value: fallback, candidates: [], ambiguous: false, missing: false, note: `未匹配状态，默认 ${fallback}` };
}
