import type { RetrievalEvidence, CragResult, RetrievalDomain } from "./types.js";
import type { RetrievalEvaluator } from "./types.js";
import { KnowledgeRefiner } from "./refine.js";
import { extractKeywords } from "./heuristic.js";

export interface CragControllerOptions {
  evaluator: RetrievalEvaluator;
  refiner?: KnowledgeRefiner;
  /** 注册的检索域：block（必选）、graph（可选）、web（预留）。 */
  domains: RetrievalDomain[];
  /** 纠正重试上限，默认 1（防循环）。 */
  maxRetries?: number;
  budgetChars?: number;
}

export interface CragRetrieveOptions {
  sources?: string[];
}

/**
 * CRAG 控制器：触发检索 → 评估 → 纠正路由 → 精炼。
 *
 * 纠正链（incorrect 时）：
 * 1. query-rewrite：抽取关键词改写查询 → 重试 block 域；
 * 2. 仍失败 → 切 graph 域（若注册）；
 * 3. 仍无 → actions 记 declared-uncovered，formatted 为空（调用方如实说明）。
 *
 * ambiguous 时：保留相关条带 + 触发 graph 域补充（若注册），统一精炼。
 */
export class CragController {
  private evaluator: RetrievalEvaluator;
  private refiner: KnowledgeRefiner;
  private domains: Map<string, RetrievalDomain>;
  private maxRetries: number;

  constructor(opts: CragControllerOptions) {
    this.evaluator = opts.evaluator;
    this.refiner = opts.refiner ?? new KnowledgeRefiner({ budgetChars: opts.budgetChars });
    this.maxRetries = opts.maxRetries ?? 1;
    this.domains = new Map(opts.domains.map((d) => [d.name, d]));
    if (!this.domains.has("block")) {
      throw new Error("CragController requires a 'block' retrieval domain");
    }
  }

  /** 查询是否需要外部知识（简单启发：非纯寒暄且含可检索词）。 */
  private static shouldRetrieve(query: string): boolean {
    const trimmed = query.trim();
    if (!trimmed || trimmed.length < 2) return false;
    const greetings = ["你好", "hi", "hello", "hey", "谢谢", "再见", "拜拜"];
    return !greetings.some((g) => trimmed.toLowerCase() === g || trimmed.toLowerCase().startsWith(`${g} `));
  }

  private async runDomain(name: string, query: string, sources?: string[]): Promise<RetrievalEvidence | null> {
    const domain = this.domains.get(name);
    if (!domain) return null;
    try {
      return await domain.retrieve(query, { sources });
    } catch {
      return null; // 单域失败不阻断整体
    }
  }

  private merge(evidence: Array<RetrievalEvidence | null>): RetrievalEvidence[] {
    return evidence.filter((e): e is RetrievalEvidence => e !== null && e.chunks.length > 0);
  }

  /** 重写查询：抽取关键词拼接（去重、去已用词）。 */
  private rewriteQuery(query: string, usedTerms: Set<string>): string {
    const terms = extractKeywords(query).filter((t) => !usedTerms.has(t));
    if (terms.length === 0) return query;
    return terms.join(" ");
  }

  async retrieve(query: string, opts: CragRetrieveOptions = {}): Promise<CragResult> {
    const actions: string[] = [];
    const { sources } = opts;

    if (!CragController.shouldRetrieve(query)) {
      actions.push("trigger-skipped");
      return { query, assessment: "incorrect", confidence: 0, formatted: "", actions, citations: [] };
    }

    // 第一轮：block 域（必选）+ graph 域（若有，并行）
    const firstRound: Array<Promise<RetrievalEvidence | null>> = [
      Promise.resolve(this.runDomain("block", query, sources)),
      Promise.resolve(this.runDomain("graph", query, sources)),
    ];
    let evidence = this.merge(await Promise.all(firstRound));
    actions.push("block-rag");
    if (evidence.some((e) => e.domain === "graph")) actions.push("graph-domain");

    if (evidence.length === 0) {
      actions.push("declared-uncovered");
      return { query, assessment: "incorrect", confidence: 0, formatted: "", actions, citations: [] };
    }

    let evaluation = await this.evaluator.evaluate(query, evidence);

    // ambiguous：保留相关条带，补充 graph 域（若尚未参与且已注册）
    if (evaluation.assessment === "ambiguous" && !evidence.some((e) => e.domain === "graph")) {
      const graph = await this.runDomain("graph", query, sources);
      if (graph) {
        evidence = this.merge([...evidence, graph]);
        actions.push("graph-supplement");
        evaluation = await this.evaluator.evaluate(query, evidence);
      }
    }

    // incorrect：纠正链
    let retries = 0;
    while (evaluation.assessment === "incorrect" && retries < this.maxRetries) {
      // 1) 改写查询重试 block 域
      const rewritten = this.rewriteQuery(query, new Set(extractKeywords(query).slice(0, 2)));
      const retried = await this.runDomain("block", rewritten, sources);
      retries += 1;
      if (retried && retried.chunks.length > 0) {
        evidence = this.merge([...evidence, retried]);
        actions.push("rewrite-retry");
        evaluation = await this.evaluator.evaluate(rewritten, evidence);
        continue;
      }
      // 2) 切 graph 域（若尚未参与）
      if (!evidence.some((e) => e.domain === "graph")) {
        const graph = await this.runDomain("graph", query, sources);
        if (graph) {
          evidence = this.merge([...evidence, graph]);
          actions.push("graph-domain");
          evaluation = await this.evaluator.evaluate(query, evidence);
          continue;
        }
      }
      break;
    }

    if (evaluation.assessment === "incorrect") {
      actions.push("declared-uncovered");
      return { query, assessment: "incorrect", confidence: evaluation.confidence, formatted: "", actions, citations: [] };
    }

    const formatted = this.refiner.recompose(evaluation.strips);
    return {
      query,
      assessment: evaluation.assessment,
      confidence: evaluation.confidence,
      formatted,
      actions,
      citations: this.refiner.citations(evaluation.strips),
    };
  }
}
