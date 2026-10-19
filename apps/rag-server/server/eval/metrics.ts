import type { EvalCase, EvalCaseResult, EvalRunSummary, RetrievedChunk } from "./types.js";

/**
 * 检索评估的指标计算：纯函数、无 IO，便于单测与回归比对。
 *
 * 指标口径：
 * - hit：检索结果命中任一期望来源；
 * - recall：命中的期望来源数 / 期望来源总数（来源级召回）；
 * - precision：命中的结果数 / 返回结果数（结果级准确率）；
 * - mrr：首个相关结果排名倒数；
 * - faithfulness：期望关键词在检索内容中的覆盖率均值，衡量「检索是否真的答到了点上」。
 */

/** 用例级指标。 */
export function computeCaseResult(evalCase: EvalCase, retrieved: RetrievedChunk[]): EvalCaseResult {
  const expected = new Set(evalCase.expectedSources);
  const relevantSources: string[] = [];
  let firstRelevantRank: number | null = null;
  for (const [index, chunk] of retrieved.entries()) {
    if (!expected.has(chunk.source)) continue;
    if (firstRelevantRank === null) firstRelevantRank = index + 1;
    if (!relevantSources.includes(chunk.source)) relevantSources.push(chunk.source);
  }
  const [top] = retrieved;
  const expectedCount = expected.size;
  return {
    caseId: evalCase.id,
    query: evalCase.query,
    retrieved: retrieved.length,
    relevantSources,
    firstRelevantRank,
    hit: relevantSources.length > 0,
    recall: expectedCount > 0 ? relevantSources.length / expectedCount : 0,
    precision: retrieved.length > 0 ? relevantSources.length / retrieved.length : 0,
    reciprocalRank: firstRelevantRank ? 1 / firstRelevantRank : 0,
    keywordCoverage: keywordCoverage(evalCase.expectedKeywords, retrieved),
    topSource: top?.source ?? null,
    error: null,
  };
}

/** 检索失败时的用例结果：计入错误数，不参与命中统计但参与用例总数。 */
export function errorCaseResult(evalCase: EvalCase, error: unknown): EvalCaseResult {
  return {
    caseId: evalCase.id,
    query: evalCase.query,
    retrieved: 0,
    relevantSources: [],
    firstRelevantRank: null,
    hit: false,
    recall: 0,
    precision: 0,
    reciprocalRank: 0,
    keywordCoverage: null,
    topSource: null,
    error: error instanceof Error ? error.message : String(error),
  };
}

export interface EvalRunMeta {
  runId: string;
  datasetId: string;
  datasetName: string;
  topK: number;
  startedAt: string;
  finishedAt: string;
}

/** 汇总一次运行的指标，供看板与历史趋势读取。 */
export function summarizeRun(meta: EvalRunMeta, results: EvalCaseResult[]): EvalRunSummary {
  const cases = results.length;
  const hits = results.filter((result) => result.hit).length;
  const errors = results.filter((result) => result.error !== null).length;
  const coverage = results
    .map((result) => result.keywordCoverage)
    .filter((value): value is number => value !== null);
  return {
    ...meta,
    cases,
    hits,
    hitRate: cases > 0 ? hits / cases : 0,
    recall: mean(results.map((result) => result.recall)),
    precision: mean(results.map((result) => result.precision)),
    mrr: mean(results.map((result) => result.reciprocalRank)),
    faithfulness: coverage.length > 0 ? mean(coverage) : null,
    errors,
    durationMs: Math.max(0, Date.parse(meta.finishedAt) - Date.parse(meta.startedAt)),
  };
}

/** 期望关键词在检索内容中的覆盖率；未定义期望关键词时为 null。 */
function keywordCoverage(keywords: string[], retrieved: RetrievedChunk[]): number | null {
  if (keywords.length === 0) return null;
  const haystack = retrieved
    .map((chunk) => chunk.content)
    .join("\n")
    .toLowerCase();
  let covered = 0;
  for (const keyword of keywords) {
    const needle = keyword.trim().toLowerCase();
    if (needle && haystack.includes(needle)) covered += 1;
  }
  return covered / keywords.length;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}
