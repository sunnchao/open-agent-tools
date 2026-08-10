import {
  CragController,
  createBlockDomain,
  createGraphDomain,
  HeuristicRetrievalEvaluator,
  type RetrievalEvaluator,
} from "@open-agent-tools/rag-crag";
import { retrieveRag, retrieveRagGraph } from "./resources.js";

/** 组装 chat 侧 CRAG 控制器：block 域 = rag-server /query，graph 域 = /graph/retrieve。 */
export function createChatCragController(evaluator?: RetrievalEvaluator): CragController {
  const block = createBlockDomain({
    retrieve: async (query, rOpts = {}) => {
      const result = await retrieveRag({
        query,
        sources: rOpts.sources ?? [],
        topK: rOpts.topK ?? 5,
      });
      return {
        chunks: result.chunks.map((c) => ({
          source: String(c.source),
          chunkIndex: Number(c.chunkIndex),
          content: String(c.content),
        })),
      };
    },
    topK: 5,
  });
  const graph = createGraphDomain({
    retrieve: async (query) => {
      const result = await retrieveRagGraph({ query });
      return {
        seeds: result.seeds,
        subgraph:
          result.formatted.length > 0
            ? { formatted: () => result.formatted }
            : null,
      };
    },
  });
  return new CragController({
    evaluator: evaluator ?? new HeuristicRetrievalEvaluator(),
    domains: [block, graph],
    maxRetries: 1,
  });
}
