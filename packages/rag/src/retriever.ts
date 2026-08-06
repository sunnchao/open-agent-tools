import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import type { RetrievalResult, ScoredChunk, VectorStore } from "./types.js";

export interface RetrieveOptions {
  /** 最终返回的命中数，默认 5。 */
  topK?: number;
  /** 每种检索器的候选窗口，默认 30。 */
  candidates?: number;
  /** RRF 常数 k，默认 60。 */
  rrfK?: number;
  /** 限定检索的文档来源；缺省为全部，空数组表示不检索。 */
  sources?: string[];
}

/**
 * 倒数排名融合（Reciprocal Rank Fusion）：
 * 只看排名不看原始分数，将多个检索器结果合并为一个列表。
 */
export function reciprocalRankFusion(lists: ScoredChunk[][], k = 60): ScoredChunk[] {
  const acc = new Map<string, { chunk: ScoredChunk; score: number }>();
  for (const list of lists) {
    list.forEach((hit, rank) => {
      const entry = acc.get(hit.id) ?? { chunk: hit, score: 0 };
      entry.score += 1 / (k + rank + 1);
      acc.set(hit.id, entry);
    });
  }
  return [...acc.values()]
    .sort((a, b) => b.score - a.score)
    .map((e) => ({ ...e.chunk, score: e.score }));
}

/**
 * 混合检索：向量 kNN（若有 embeddings）+ FTS5 BM25 → RRF 融合 → Top-K。
 * 无 embeddings 时退化为纯关键词检索。
 */
export async function retrieve(
  store: VectorStore,
  embeddings: EmbeddingsInterface | undefined,
  query: string,
  opts: RetrieveOptions = {},
): Promise<RetrievalResult> {
  const { topK = 5, candidates = 30, rrfK = 60, sources } = opts;
  if (sources?.length === 0) {
    return { query, chunks: [], formatted: () => "" };
  }
  const lists: ScoredChunk[][] = [];
  if (embeddings) {
    const qv = (await embeddings.embedDocuments([query]))[0] ?? [];
    lists.push(store.vectorSearch(qv, candidates, sources));
  }
  lists.push(store.keywordSearch(query, candidates, sources)); // store 内部做 CJK 切分 + AND→OR 降级

  const chunks = reciprocalRankFusion(lists, rrfK).slice(0, topK);
  return { query, chunks, formatted: () => formatChunks(chunks) };
}

/** 带引用格式，可直接拼入 system prompt。 */
export function formatChunks(chunks: ScoredChunk[]): string {
  if (chunks.length === 0) return "";
  return chunks
    .map((c) => `【来源: ${c.source} · 第${c.chunkIndex + 1}段】\n${c.content}`)
    .join("\n\n");
}
