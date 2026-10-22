import type { GraphChannelSource, Rag } from "@open-agent-tools/rag";
import type { KnowledgeGraph } from "@open-agent-tools/rag/graph";

/**
 * 图谱检索通道的 late-bind 引用。
 *
 * Rag 必须在构造时拿到 graph 通道，而图谱本身又依赖 Rag（分块输入）才能建图；
 * 用取值函数打破构造顺序的循环，两处都拿到「调用时才解析」的同一实例。
 */
export interface GraphChannelRefs {
  rag: () => Rag | undefined;
  graph: () => KnowledgeGraph | undefined;
}

/** 把 KnowledgeGraph 适配成 packages/rag 的 GraphChannelSource（第三路召回入口）。 */
export function createGraphChannel(refs: GraphChannelRefs): GraphChannelSource {
  return {
    async retrieve(query, opts = {}) {
      const graph = refs.graph();
      // 图谱尚未初始化（或启动期构造失败降级）时返回空子图：检索应继续走两路，不因图谱缺失而失败。
      if (!graph) return { seeds: [], subgraph: null };
      const result = await graph.retrieve(query, opts);
      return { seeds: result.seeds, subgraph: result.subgraph };
    },
    async getChunksByIds(ids, sources) {
      const rag = refs.rag();
      if (!rag) return [];
      return rag.getChunksByIds(ids, sources);
    },
  };
}
