import type { DraftQuery, DraftSlots } from "./types.js";
import type { OrgDirectory, OrgEntry } from "./resolvers/orgResolver.js";

export interface SlotExtractorOptions {
  orgDirectory: OrgDirectory;
  /**
   * 可选 LLM 抽取注入点：正则扫不到的维度交给模型补。
   * 模型产出会做"回原文校验"——片段必须能在原话里找到，否则视为编造丢弃。
   */
  llmExtract?: (utterance: string, partial: DraftSlots) => DraftSlots | Promise<DraftSlots>;
}

// 长匹配优先，避免"差旅报销"被切成"差旅"
const DATE_RE =
  /(上{1,2}个?月|本\s*月|这个月|这月|本季度|上季度|去\s*年|前\s*年|最近\s*\d+\s*天|\d{4}\s*年\s*\d{1,2}\s*月|\d{4}-\d{1,2})/;
const STATUS_RE = /(已通过|已审批|审批通过|已驳回|驳回|被拒|审批中|待审批|待审核)/;
const EXPENSE_RE =
  /(差旅报销|差旅费|差旅|出差|交通费|住宿|餐饮|餐费|吃饭|用餐|招待|商务接待|业务招待|报销|费用)/;
const INTENT_RE = /(报销|审批|查询|查一下|统计|多少|列表)/;

function buildOrgRegex(dir: OrgDirectory): RegExp {
  const aliases: string[] = dir.flatMap((e: OrgEntry) => [e.name, ...e.aliases]);
  const escaped = aliases
    .map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .filter((a) => a.length > 0);
  escaped.sort((a, b) => b.length - a.length); // 最长优先，先抓具体
  return new RegExp(`(${escaped.join("|")})`);
}

const SLOT_KEYS = ["date_raw", "org_raw", "expense_raw", "status_raw"] as const;

/**
 * 意图识别 + 槽位抽取（混合方案）。
 * 1) 正则快路径：确定性强、零 token、可单测；
 * 2) 可选 LLM 补位：填正则漏掉的维度，并回原文校验；
 * 3) 校验：所有抽取片段必须能在原话中找到（历史轮携带的 partial 除外）；
 * 4) 多轮携带：partial 中的槽位继承，本轮命中则覆盖。
 */
export async function extractSlots(
  utterance: string,
  partial: DraftSlots = {},
  opts: SlotExtractorOptions,
): Promise<DraftQuery> {
  const slots: DraftSlots = { ...partial };

  const dateM = utterance.match(DATE_RE);
  if (dateM?.[1]) slots.date_raw = dateM[1];

  const orgM = utterance.match(buildOrgRegex(opts.orgDirectory));
  if (orgM?.[1]) slots.org_raw = orgM[1];

  const expM = utterance.match(EXPENSE_RE);
  if (expM?.[1]) slots.expense_raw = expM[1];

  const statusM = utterance.match(STATUS_RE);
  if (statusM?.[1]) slots.status_raw = statusM[1];

  if (opts.llmExtract) {
    const llm = await opts.llmExtract(utterance, partial);
    for (const key of SLOT_KEYS) {
      const v = llm[key];
      if (v && !slots[key] && utterance.includes(v)) slots[key] = v;
    }
  }

  // 回原文校验：本轮抽取但原话里找不到的，视为不可信，丢弃
  for (const key of SLOT_KEYS) {
    const v = slots[key];
    if (v && !partial[key] && !utterance.includes(v)) {
      delete slots[key];
    }
  }

  // 出现费用/审批/报销类关键词即视为报销查询意图；缺哪个维度交给编排器反问
  const intent =
    slots.expense_raw || slots.status_raw || INTENT_RE.test(utterance) ? "expense_query" : "other";

  return { intent, slots };
}
