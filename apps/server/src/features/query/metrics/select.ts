import { renderCaliberExpression } from "./caliber.js";
import { listMetricDefinitions, type MetricDefinition } from "./store.js";

export interface MetricMatch {
  metric: MetricDefinition;
  score: number;
  matchedTerms: string[];
}

export interface SelectMetricOptions {
  limit?: number;
  /** 最低命中分数，低于该值不返回。默认 1。 */
  minScore?: number;
  sourceId?: string;
}

function termsOf(metric: MetricDefinition): string[] {
  return [metric.name, ...metric.synonyms, ...metric.tags, metric.category ?? ""].filter(Boolean);
}

/**
 * 依据用户问题对指标做关键词命中打分：
 * - 指标名称/同义词/标签作为待匹配词；命中一次计 1 分，长词权重更高。
 * - 名称整体包含在问题中额外加 2 分。
 * 返回按分数降序的匹配结果（可直接喂给 LLM 做口径澄清）。
 */
export function selectMetrics(
  question: string,
  options: SelectMetricOptions = {},
): MetricMatch[] {
  const query = question.trim().toLowerCase();
  if (!query) return [];
  const limit = options.limit ?? 5;
  const minScore = options.minScore ?? 1;
  const metrics = listMetricDefinitions({
    status: "active",
    ...(options.sourceId ? { sourceId: options.sourceId } : {}),
  });

  const matches: MetricMatch[] = [];
  for (const metric of metrics) {
    let score = 0;
    const matchedTerms: string[] = [];
    for (const term of termsOf(metric)) {
      const normalized = term.toLowerCase();
      if (!normalized) continue;
      if (query.includes(normalized)) {
        score += 1 + Math.min(2, Math.floor(normalized.length / 4));
        matchedTerms.push(term);
      }
    }
    if (metric.name && query.includes(metric.name.toLowerCase())) score += 2;
    if (score >= minScore) matches.push({ metric, score, matchedTerms });
  }

  return matches.sort((left, right) => right.score - left.score).slice(0, limit);
}

/** 将命中的指标口径渲染为可注入 prompt 的文本块；无命中返回空串。 */
export function renderMetricPromptBlock(matches: MetricMatch[]): string {
  if (matches.length === 0) return "";
  const lines = matches.map((match) => {
    const { metric } = match;
    const parts = [`- ${metric.name}`];
    if (metric.unit) parts.push(`单位: ${metric.unit}`);
    parts.push(`口径: ${renderCaliberExpression(metric.caliber)}`);
    const filters = metric.caliber.filters
      .map((filter) => `${filter.field} ${filter.operator} ${formatValue(filter.value)}`.trim())
      .join(" AND ");
    if (filters) parts.push(`限定: ${filters}`);
    if (metric.caliber.timeField) parts.push(`时间字段: ${metric.caliber.timeField}`);
    if (metric.caliber.dimensions.length)
      parts.push(`可下钻维度: ${metric.caliber.dimensions.join(", ")}`);
    if (metric.caliber.notes) parts.push(`说明: ${metric.caliber.notes}`);
    if (metric.tables.length) parts.push(`相关表: ${metric.tables.join(", ")}`);
    return parts.join(" | ");
  });
  return ["【指标口径字典】命中以下业务指标，请优先按既定口径生成 SQL：", ...lines].join("\n");
}

function formatValue(value: unknown): string {
  if (value === undefined) return "";
  if (Array.isArray(value)) return `(${value.join(", ")})`;
  return String(value);
}
