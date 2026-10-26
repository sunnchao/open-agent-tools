import {
  CragController,
  createBlockDomain,
  createGraphDomain,
  HeuristicRetrievalEvaluator,
  type RetrievalEvaluator,
} from "@open-agent-tools/rag/crag";
import { retrieveRag, retrieveRagGraph } from "../resources/catalog.js";

/** 组装 chat 侧 CRAG 控制器：block 域 = rag-server /query，graph 域 = /graph/retrieve。 */
export function createChatCragController(
  evaluator?: RetrievalEvaluator,
  viewerGroups?: string[],
): CragController {
  const block = createBlockDomain({
    retrieve: async (query, rOpts = {}) => {
      const result = await retrieveRag({
        query,
        sources: rOpts.sources ?? [],
        topK: rOpts.topK ?? 5,
        // CRAG 已注册独立的 graph 域并行召回；block 域若再让 rag-server 做图谱增强，
        // 同一份子图事实会被算成两路证据、抬高评估置信度，所以这里显式关闭图谱通道。
        graph: false,
        ...(viewerGroups !== undefined ? { viewerGroups } : {}),
      });
      return {
        chunks: result.chunks.map((c) => ({
          source: String(c.source),
          chunkIndex: Number(c.chunkIndex),
          content: String(c.content),
          ...(typeof c.score === "number" ? { score: c.score } : {}),
        })),
      };
    },
    topK: 5,
  });
  const graph = createGraphDomain({
    retrieve: async (query, opts = {}) => {
      // 图谱域与 block 域使用同一份 sources / viewerGroups；空数组已在 createGraphDomain 中短路。
      const result = await retrieveRagGraph({
        query,
        ...(opts.sources ? { sources: opts.sources } : {}),
        ...(viewerGroups !== undefined ? { viewerGroups } : {}),
      });
      return {
        seeds: result.seeds,
        subgraph: result.formatted.length > 0 ? { formatted: () => result.formatted } : null,
      };
    },
  });
  return new CragController({
    evaluator: evaluator ?? new HeuristicRetrievalEvaluator(),
    domains: [block, graph],
    maxRetries: 1,
  });
}
