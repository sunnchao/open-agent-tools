import type {
  ApprovalStatus,
  Caliber,
  DraftQuery,
  DraftSlots,
  ExpenseEnum,
  Period,
  TimeField,
} from "./types.js";
import { extractSlots } from "./extractSlots.js";
import { resolveDate, shanghaiNow } from "./resolvers/dateResolver.js";
import { resolveOrg, type OrgDirectory, type OrgValue } from "./resolvers/orgResolver.js";
import { resolveExpense } from "./resolvers/expenseResolver.js";
import { resolveStatus } from "./resolvers/statusResolver.js";

export interface ResolveContext {
  orgDirectory: OrgDirectory;
  timezone?: string;
  now?: Date;
  expenseDefault?: ExpenseEnum;
  statusDefault?: ApprovalStatus;
  timeFieldDefault?: TimeField;
  /** 授权可查的组织编码白名单；未配置则不限制 */
  authorizedOrgs?: string[];
  /** 可选 LLM 抽取注入点，透传给 extractSlots 补正则漏掉的维度 */
  llmExtract?: (utterance: string, partial: DraftSlots) => DraftSlots | Promise<DraftSlots>;
}

export type ResolveOutcome =
  | { ok: true; caliber: Caliber; draft: DraftQuery }
  | {
      ok: false;
      reason: "ambiguous" | "missing" | "unauthorized" | "no_intent";
      askUser: string;
      draft: DraftQuery;
      candidates?: { label: string; value: unknown; score: number }[];
    };

/**
 * 查询前置编排器：抽取 → 四维解析 → 统一校验/冲突检测 → 组装 caliber。
 * - 歧义（如组织多义）：返回候选，交由 Skill 反问；
 * - 缺失（用户说了时间但解析不出 / 缺组织）：反问；
 * - 越权（组织不在白名单）：直接拒绝；
 * - 全确定：返回可追溯的 caliber，交给 function tool 执行。
 */
export async function preQueryResolve(
  utterance: string,
  partial: DraftSlots = {},
  ctx: ResolveContext,
): Promise<ResolveOutcome> {
  const draft = await extractSlots(utterance, partial, {
    orgDirectory: ctx.orgDirectory,
    llmExtract: ctx.llmExtract,
  });

  if (draft.intent === "other") {
    return {
      ok: false,
      reason: "no_intent",
      askUser: "未识别到报销查询意图，请说明要查什么，例如：北京分公司上月的差旅报销审批。",
      draft,
    };
  }

  const now = ctx.now ?? shanghaiNow();
  const tz = ctx.timezone ?? "Asia/Shanghai";

  const dateR = resolveDate(draft.slots.date_raw, now, tz);
  const orgR = resolveOrg(draft.slots.org_raw, ctx.orgDirectory);
  const expR = resolveExpense(draft.slots.expense_raw, ctx.expenseDefault ?? "TRAVEL");
  const statusR = resolveStatus(draft.slots.status_raw, ctx.statusDefault ?? "APPROVED");

  if (orgR.ambiguous) {
    const list = orgR.candidates.map((c) => `· ${c.label}`).join("\n");
    return {
      ok: false,
      reason: "ambiguous",
      askUser: `“${draft.slots.org_raw}”匹配到多个组织，请确认：\n${list}`,
      draft,
      candidates: orgR.candidates,
    };
  }
  if (orgR.missing) {
    return {
      ok: false,
      reason: "missing",
      askUser: "未识别到要查询的组织（分公司/部门），请说明，例如：北京分公司。",
      draft,
    };
  }
  const org = orgR.value as OrgValue;

  if (ctx.authorizedOrgs && !ctx.authorizedOrgs.includes(org.code)) {
    return {
      ok: false,
      reason: "unauthorized",
      askUser: `无权限查询组织 ${org.name}（${org.code}）。`,
      draft,
    };
  }

  // 时间：用户给了但解析不出 → 反问；没给 → 默认上月
  let period: Period;
  if (dateR.value) {
    period = dateR.value;
  } else if (draft.slots.date_raw) {
    return {
      ok: false,
      reason: "missing",
      askUser: `无法解析时间表达式：“${draft.slots.date_raw}”，请换一种说法（如：上个月 / 2026年7月 / 最近30天）。`,
      draft,
    };
  } else {
    period = resolveDate(undefined, now, tz).value as Period;
  }

  const caliber: Caliber = {
    intent: draft.intent,
    org: { code: org.code, raw: draft.slots.org_raw ?? "", note: orgR.note },
    period: { ...period, raw: draft.slots.date_raw ?? "上个月(默认)" },
    expense: { enum: expR.value ?? "TRAVEL", raw: draft.slots.expense_raw ?? "差旅(默认)", note: expR.note },
    status: statusR.value ?? "APPROVED",
    time_field: ctx.timeFieldDefault ?? "approve",
  };

  return { ok: true, caliber, draft };
}
