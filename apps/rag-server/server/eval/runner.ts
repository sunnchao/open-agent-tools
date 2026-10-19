import { randomUUID } from "node:crypto";
import { computeCaseResult, errorCaseResult, summarizeRun } from "./metrics.js";
import type { EvalStore } from "./store.js";
import type { EvalCase, EvalCaseResult, EvalRun, RetrievedChunk } from "./types.js";

/**
 * 检索器的最小契约。
 *
 * 只要求「问题 + 参数 → 命中分块」，因此真实 Rag 与测试替身都能直接注入，
 * 评估逻辑不与 @open-agent-tools/rag 的检索结果类型耦合。
 */
export type RetrievalFn = (
  query: string,
  options: { topK: number; sources?: string[] },
) => Promise<RetrievedChunk[]>;

export interface EvalRunnerOptions {
  store: EvalStore;
  retrieve: RetrievalFn;
}

/** 逐条执行评测集检索，按指标汇总并落库，供看板读取。 */
export class EvalRunner {
  private readonly store: EvalStore;
  private readonly retrieve: RetrievalFn;

  constructor(options: EvalRunnerOptions) {
    this.store = options.store;
    this.retrieve = options.retrieve;
  }

  async run(datasetId: string, options: { topK: number }): Promise<EvalRun> {
    const dataset = this.store.getDataset(datasetId);
    if (!dataset) throw new Error("dataset not found");
    const startedAt = new Date().toISOString();
    const results: EvalCaseResult[] = [];
    for (const evalCase of dataset.cases) {
      results.push(await this.#runCase(evalCase, options.topK));
    }
    const finishedAt = new Date().toISOString();
    const run: EvalRun = {
      ...summarizeRun(
        {
          runId: randomUUID(),
          datasetId: dataset.id,
          datasetName: dataset.name,
          topK: options.topK,
          startedAt,
          finishedAt,
        },
        results,
      ),
      results,
    };
    this.store.saveRun(run);
    return run;
  }

  /** 单条用例失败（如检索超时）只记为错误，不中断整轮评估。 */
  async #runCase(evalCase: EvalCase, topK: number): Promise<EvalCaseResult> {
    try {
      const retrieved = await this.retrieve(evalCase.query, {
        topK,
        ...(evalCase.sources && evalCase.sources.length > 0 ? { sources: evalCase.sources } : {}),
      });
      return computeCaseResult(evalCase, retrieved ?? []);
    } catch (error) {
      return errorCaseResult(evalCase, error);
    }
  }
}
