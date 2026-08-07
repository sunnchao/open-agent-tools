import type { Evaluation, KnowledgeStrip, RetrievalEvidence } from "./types.js";
import { splitStrips } from "./evaluator.js";

export interface HeuristicEvaluatorOptions {
  /** 总命中数低于该值判 incorrect，默认 1。 */
  minHits?: number;
  /** 查询词覆盖率的阈值：低于该值判 incorrect，默认 0.25。 */
  minCoverage?: number;
  /** 每个证据最多切条带数，默认 20。 */
  maxStrips?: number;
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

  constructor(opts: HeuristicEvaluatorOptions = {}) {
    this.minHits = opts.minHits ?? 1;
    this.minCoverage = opts.minCoverage ?? 0.25;
    this.maxStrips = opts.maxStrips ?? 20;
  }

  async evaluate(query: string, evidence: RetrievalEvidence[]): Promise<Evaluation> {
    const keywords = extractKeywords(query);
    const allChunks = evidence.flatMap((e) => e.chunks);
    if (allChunks.length === 0) {
      return { assessment: "incorrect", confidence: 0, strips: [] };
    }
    if (keywords.length === 0) {
      // 无关键词可判（纯符号/超短查询）：有命中就视为 correct
      const strips = allChunks.flatMap((c) => splitStrips(c, this.maxStrips));
      return { assessment: "correct", confidence: 0.6, strips };
    }
    const joined = allChunks.map((c) => c.content).join(" ").toLowerCase();
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
}

/** 结构兼容的最小接口。 */
interface EvaluatorLike {
  evaluate(query: string, evidence: RetrievalEvidence[]): Promise<Evaluation>;
}
