/**
 * 检索评估基准的领域类型。
 *
 * 评测集（dataset）= 一组带标准答案的用例（case）；
 * 一次运行（run）= 对评测集逐条执行检索并按指标汇总，作为回归看板的数据源。
 */

/** 单条评测用例：一个问题 + 期望命中的来源 + 期望覆盖的关键词。 */
export interface EvalCase {
  id: string;
  query: string;
  /** 期望在检索结果中出现的来源，至少一个；命中任一即算 hit。 */
  expectedSources: string[];
  /** 期望被检索内容覆盖的关键词/短语，用于忠实度（关键词覆盖率）指标。 */
  expectedKeywords: string[];
  /** 可选：仅在这些来源内检索。 */
  sources?: string[];
}

export interface EvalDataset {
  id: string;
  name: string;
  description: string;
  cases: EvalCase[];
  createdAt: string;
  updatedAt: string;
}

/** 看板/列表用：不含用例明细。 */
export interface EvalDatasetSummary {
  id: string;
  name: string;
  description: string;
  cases: number;
  createdAt: string;
  updatedAt: string;
}

/** 检索命中的最小结构，便于与 @open-agent-tools/rag 解耦。 */
export interface RetrievedChunk {
  source: string;
  content: string;
}

export interface EvalCaseResult {
  caseId: string;
  query: string;
  retrieved: number;
  /** 命中的期望来源（去重）。 */
  relevantSources: string[];
  /** 第一个相关结果的排名（1 起），未命中为 null。 */
  firstRelevantRank: number | null;
  hit: boolean;
  recall: number;
  precision: number;
  reciprocalRank: number;
  /** 关键词覆盖率，未定义期望关键词时为 null。 */
  keywordCoverage: number | null;
  topSource: string | null;
  error: string | null;
}

export interface EvalRunSummary {
  runId: string;
  datasetId: string;
  datasetName: string;
  topK: number;
  cases: number;
  hits: number;
  hitRate: number;
  recall: number;
  precision: number;
  mrr: number;
  /** 关键词覆盖率均值，无期望关键词时为 null。 */
  faithfulness: number | null;
  errors: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface EvalRun extends EvalRunSummary {
  results: EvalCaseResult[];
}

/** 评估看板：最近一次运行 + 历史趋势 + 数据集规模。 */
export interface EvalOverview {
  datasets: number;
  cases: number;
  latest: EvalRunSummary | null;
  history: EvalRunSummary[];
  /** 最近一次运行中未命中的用例，便于定位退化问题。 */
  misses: EvalCaseResult[];
}
