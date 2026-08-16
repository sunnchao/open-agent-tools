import { CragController, type CragControllerOptions } from "./controller.js";
import { HeuristicRetrievalEvaluator } from "./heuristic.js";

export type {
  Assessment,
  KnowledgeStrip,
  EvidenceChunk,
  RetrievalEvidence,
  Evaluation,
  CragResult,
  RetrievalDomain,
  RetrievalEvaluator,
} from "./types.js";
export { LlmRetrievalEvaluator, splitStrips, type LlmEvaluatorOptions, type EvaluatorChatFn } from "./evaluator.js";
export {
  HeuristicRetrievalEvaluator,
  extractKeywords,
  type HeuristicEvaluatorOptions,
} from "./heuristic.js";
export { KnowledgeRefiner, type RefinerOptions } from "./refine.js";
export { CragController, type CragControllerOptions, type CragRetrieveOptions } from "./controller.js";
export { createBlockDomain, createGraphDomain, type BlockDomainOptions, type GraphDomainOptions } from "./domains.js";

/** 便捷门面：用启发式评估器 + 指定检索域组装开箱即用的 CRAG 控制器（离线可用）。 */
export function buildHeuristicCrag(opts: CragControllerOptions): CragController {
  return new CragController({
    ...opts,
    evaluator: opts.evaluator ?? new HeuristicRetrievalEvaluator(),
  });
}
