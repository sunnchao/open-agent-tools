import type { RetrievalDomain, RetrievalEvidence } from "./types.js";

/**
 * block 检索域：包装 packages/rag 的 retrieve（向量 + BM25 → RRF）。
 * 通过函数注入避免强依赖 rag 包（调用方自行组装）。
 */
export interface BlockDomainOptions {
  /** rag.retrieve 包装函数（或包装 rag-server /query 的 HTTP 调用）。 */
  retrieve: (query: string, opts?: { sources?: string[]; topK?: number }) => Promise<{
    chunks: Array<{ source: string; chunkIndex: number; content: string }>;
  }>;
  topK?: number;
  name?: string;
}

export function createBlockDomain(opts: BlockDomainOptions): RetrievalDomain {
  const topK = opts.topK ?? 5;
  return {
    name: opts.name ?? "block",
    async retrieve(query, rOpts = {}): Promise<RetrievalEvidence> {
      const result = await opts.retrieve(query, {
        sources: rOpts.sources,
        topK,
      });
      return {
        domain: opts.name ?? "block",
        chunks: result.chunks.map((c) => ({ source: c.source, chunkIndex: c.chunkIndex, content: c.content })),
      };
    },
  };
}

/** graph 检索域：包装 packages/rag-graph 的 GraphRetriever.retrieve（或 HTTP 调用）。 */
export interface GraphDomainOptions {
  retrieve: (query: string) =>
    | {
        subgraph: { formatted(): string } | null;
        seeds: Array<{ name: string }>;
      }
    | Promise<{
        subgraph: { formatted(): string } | null;
        seeds: Array<{ name: string }>;
      }>;
  name?: string;
}

export function createGraphDomain(opts: GraphDomainOptions): RetrievalDomain {
  return {
    name: opts.name ?? "graph",
    async retrieve(query): Promise<RetrievalEvidence> {
      const result = await opts.retrieve(query);
      if (!result.subgraph || result.seeds.length === 0) {
        return { domain: opts.name ?? "graph", chunks: [] };
      }
      const text = result.subgraph.formatted();
      return {
        domain: opts.name ?? "graph",
        chunks: text
          ? [{ source: "[图谱]", chunkIndex: 0, content: text }]
          : [],
      };
    },
  };
}
