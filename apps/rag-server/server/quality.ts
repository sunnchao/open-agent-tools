export type NoAnswerAttributionValue =
  "no_documents" | "retrieval_miss" | "low_relevance" | "model_refusal" | "error";
export type QueryEventAttribution = NoAnswerAttributionValue | "answered" | "unknown";

export const NO_ANSWER_ATTRIBUTIONS = [
  "no_documents",
  "retrieval_miss",
  "low_relevance",
  "model_refusal",
  "error",
] as const;

export interface AttributionInput {
  error?: string | null;
  crag: boolean;
  generate: boolean;
  hits: number;
  sourceCount: number;
  answerGenerated: boolean;
  answer: string | null;
  generationAttempted: boolean;
  assessment?: "correct" | "ambiguous" | "incorrect";
  actions?: readonly string[];
}

/**
 * 按请求中真实可观测的数据判定无答案原因。
 *
 * 优先级：基础设施错误 > 无可见文档 > CRAG 评估不相关 > 检索未命中 > 模型拒答 > 回答成功。
 * CRAG 判定只采用控制器实际返回的 assessment/actions，不根据问题文本猜测。
 */
export function deriveQueryAttribution(input: AttributionInput): QueryEventAttribution {
  if (input.error?.trim()) return "error";
  if (input.sourceCount <= 0) return "no_documents";
  if (input.crag && input.assessment === "incorrect") {
    return cragRetrievedEvidence(input.actions) ? "low_relevance" : "retrieval_miss";
  }
  if (input.hits <= 0) return "retrieval_miss";
  if (input.generate && isRefusal(input.answer)) return "model_refusal";
  if (input.generationAttempted && !input.answerGenerated) return "model_refusal";
  return "answered";
}

/**
 * CRAG 只在纠错动作里留下是否真的取到过候选的信号。
 * `declared-uncovered` 出现两次表示首轮有候选但评估未通过,而不是零召回。
 */
function cragRetrievedEvidence(actions: readonly string[] | undefined): boolean {
  if (!actions) return false;
  const declaredUncovered = actions.filter((action) => action === "declared-uncovered").length;
  return (
    actions.includes("rewrite-retry") ||
    actions.includes("graph-domain") ||
    actions.includes("graph-supplement") ||
    declaredUncovered > 1
  );
}

/** 识别模型明确给出「无法回答」的情况；正常回答即使包含“不确定”也不算拒答。 */
export function isRefusal(answer: string | null | undefined): boolean {
  const normalized = answer?.trim().replace(/\s+/g, " ") ?? "";
  if (!normalized) return false;
  if (normalized.length > 320) return false;

  const patterns = [
    /(?:资料|文档|上下文|知识库)(?:中|里)?(?:未|没有|无法|不能)(?:找到|提及|包含|覆盖|提供)/,
    /(?:无法|不能)(?:根据|基于)(?:提供|现有|上述)?(?:的)?(?:资料|文档|上下文)/,
    /(?:暂无|没有)(?:足够|相关)(?:的)?(?:资料|信息|内容)/,
    /(?:资料|信息|内容)(?:不足|有限).{0,20}(?:无法|不能)(?:回答|确定|判断)/,
    /(?:i (?:could not|couldn't|cannot|can't) (?:find|answer|determine)|not enough information|no relevant (?:information|documents)|unable to answer)/i,
  ];
  return patterns.some((pattern) => pattern.test(normalized));
}

export interface QualityReportDaily {
  date: string;
  queries: number;
  answered: number;
  noAnswer: number;
  hitRate: number;
  noAnswerRate: number;
}

export type QualityReportAttribution = Record<QueryEventAttribution, number>;

export interface QualityReport {
  periodDays: number;
  generatedAt: string;
  totals: {
    queries: number;
    answered: number;
    hits: number;
    noAnswer: number;
    hitRate: number;
    noAnswerRate: number;
  };
  attribution: QualityReportAttribution;
  topUnanswered: Array<{ query: string; count: number; attribution: NoAnswerAttributionValue }>;
  trend: QualityReportDaily[];
}
