import type { Evaluation, KnowledgeStrip, RetrievalEvidence } from "./types.js";
import { splitStrips } from "./evaluator.js";

export interface HeuristicEvaluatorOptions {
  /** 预留：纯关键词检索时的最少命中数。 */
  minHits?: number;
  /** 无分数证据（纯关键词检索）时，查询词覆盖率的阈值，默认 0.25。 */
  minCoverage?: number;
  /** 每个证据最多切条带数，默认 20。 */
  maxStrips?: number;
  /**
   * 有向量/融合分数时的最低相关门限。缺省关闭：不同检索器的分数量纲不同，
   * 不能用一个写死的余弦阈值套到 RRF 分上。
   */
  semanticThreshold?: number;
}

/** 从查询中提取关键词（英文词 + 中文 2 字滑窗）。 */
export function extractKeywords(query: string): string[] {
  const terms = new Set<string>();
  for (const match of query.matchAll(/[A-Za-z][A-Za-z0-9_]{1,}/g)) {
    terms.add(match[0]!.toLowerCase());
  }
  for (const match of query.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const seq = match[0]!;
    for (let i = 0; i + 2 <= seq.length; i += 1) {
      terms.add(seq.slice(i, i + 2));
    }
  }
  return [...terms];
}

/**
 * 启发式评估器（无 LLM / 调用失败时回退）：
 * - 命中数 < minHits → incorrect；
 * - 否则计算查询关键词在命中文本中的覆盖率，低于 minCoverage → incorrect；
 * - 覆盖率中等（0.25~0.6）→ ambiguous；高 → correct。
 * 条带相关性按是否包含关键词标注（粗粒度，供精炼阶段过滤）。
 */
export class HeuristicRetrievalEvaluator implements EvaluatorLike {
  private minHits: number;
  private minCoverage: number;
  private maxStrips: number;
  private semanticThreshold?: number;

  constructor(opts: HeuristicEvaluatorOptions = {}) {
    this.minHits = opts.minHits ?? 1;
    this.minCoverage = opts.minCoverage ?? 0.25;
    this.maxStrips = opts.maxStrips ?? 20;
    this.semanticThreshold = opts.semanticThreshold;
  }

  async evaluate(query: string, evidence: RetrievalEvidence[]): Promise<Evaluation> {
    const keywords = extractKeywords(query);
    const allChunks = evidence.flatMap((e) => e.chunks);
    if (allChunks.length === 0) {
      return { assessment: "incorrect", confidence: 0, strips: [] };
    }
    if (allChunks.length < this.minHits) {
      return { assessment: "incorrect", confidence: 0, strips: [] };
    }

    // 语义优先：有分数的检索结果不应再被「中文二字滑窗字面覆盖率」否决。
    // 取 top-1 相对分数（top1 / 候选均值）作为区分力，避免依赖某一种分数量纲。
    const scored = allChunks.filter((chunk) => Number.isFinite(chunk.score));
    if (scored.length > 0) {
      const sorted = [...scored].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      const top = sorted[0]?.score ?? 0;
      const mean =
        sorted.reduce((sum, chunk) => sum + Math.max(0, chunk.score ?? 0), 0) / sorted.length;
      const separation = mean > 0 ? top / mean : 0;
      const confidence = Math.max(0, Math.min(1, separation / 2));
      if (this.semanticThreshold !== undefined && top < this.semanticThreshold) {
        return { assessment: "incorrect", confidence, strips: [] };
      }
      const strips = allChunks.flatMap((chunk) =>
        splitStrips(chunk, this.maxStrips).map((strip) => ({
          ...strip,
          // top-1 的条带保留；其余分块只有在接近 top 时才保留，避免把候选噪声注入 prompt。
          relevant:
            chunk === sorted[0] ||
            (top > 0 && (chunk.score ?? 0) >= top * 0.5) ||
            this.keywordCoverage(query, strip.text) > 0,
        })),
      );
      return {
        assessment: separation >= 1.35 ? "correct" : "ambiguous",
        confidence,
        strips,
      };
    }

    if (keywords.length === 0) {
      // 无关键词可判（纯符号/超短查询）：有命中就视为 correct
      const strips = allChunks.flatMap((c) => splitStrips(c, this.maxStrips));
      return { assessment: "correct", confidence: 0.6, strips };
    }
    const joined = allChunks
      .map((c) => c.content)
      .join(" ")
      .toLowerCase();
    const hitCount = keywords.filter((k) => joined.includes(k)).length;
    const coverage = hitCount / keywords.length;

    const strips: KnowledgeStrip[] = allChunks.flatMap((c) =>
      splitStrips(c, this.maxStrips).map((s) => ({
        ...s,
        relevant: keywords.some((k) => s.text.toLowerCase().includes(k)),
      })),
    );

    if (coverage < this.minCoverage) {
      return { assessment: "incorrect", confidence: coverage, strips };
    }
    if (coverage < 0.6) {
      return { assessment: "ambiguous", confidence: coverage, strips };
    }
    return { assessment: "correct", confidence: coverage, strips };
  }

  private keywordCoverage(query: string, text: string): number {
    const keywords = extractKeywords(query);
    if (keywords.length === 0) return 0;
    const lower = text.toLowerCase();
    return keywords.filter((keyword) => lower.includes(keyword)).length / keywords.length;
  }
}

/** 结构兼容的最小接口。 */
interface EvaluatorLike {
  evaluate(query: string, evidence: RetrievalEvidence[]): Promise<Evaluation>;
}
