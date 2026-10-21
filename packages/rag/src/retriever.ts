import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import type {
  ChannelHit,
  RetrievalResult,
  ScoredChunk,
  ScoredChunkDebug,
  VectorStore,
} from "./types.js";

export interface RetrieveOptions {
  /** 最终返回的命中数，默认 5。 */
  topK?: number;
  /** 每种检索器的候选窗口，默认 30。 */
  candidates?: number;
  /** RRF 常数 k，默认 60。 */
  rrfK?: number;
  /** 限定检索的文档来源；缺省为全部，空数组表示不检索。 */
  sources?: string[];
  /**
   * 请求方所属分组。缺省表示管理侧不启用文档 ACL；显式空数组只返回公开文档。
   * 分组匹配在 `Rag.retrieve` 中转换为来源白名单后下推到检索器。
   */
  viewerGroups?: string[];
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
 *
 * 返回的 chunks.score 为 RRF 融合分；chunks[].debug 与 result.debug 保留双路
 * 原始分（向量余弦 / BM25）与排名，供前端区分展示与审计回溯。
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
  let vectorList: ScoredChunk[] = [];
  let vectorMs: number | null = null;
  if (embeddings) {
    const started = Date.now();
    const qv = (await embeddings.embedDocuments([query]))[0] ?? [];
    vectorList = await store.vectorSearch(qv, candidates, sources);
    vectorMs = Date.now() - started;
  }
  const keywordStarted = Date.now();
  const keywordList = await store.keywordSearch(query, candidates, sources); // store 内部做 CJK 切分 + AND→OR 降级
  const keywordMs = Date.now() - keywordStarted;

  const fusionStarted = Date.now();
  const chunks = reciprocalRankFusionWithDebug(vectorList, keywordList, rrfK).slice(0, topK);
  const fusionMs = Date.now() - fusionStarted;
  const debug = {
    embeddingsEnabled: Boolean(embeddings),
    candidates,
    rrfK,
    timingsMs: { vectorMs, keywordMs, fusionMs },
    vectorHits: withRank(vectorList),
    keywordHits: withRank(keywordList),
  };
  return { query, chunks, formatted: () => formatChunks(chunks), debug };
}

function withRank(list: ScoredChunk[]): ChannelHit[] {
  return list.map((hit, rank) => ({
    id: hit.id,
    source: hit.source,
    chunkIndex: hit.chunkIndex,
    content: hit.content,
    score: hit.score,
    rank,
  }));
}

/**
 * 带双路明细的 RRF：除融合分外，还记录每个命中的向量/关键词原始分与排名。
 * channels 用于前端打标“仅向量 / 仅关键词 / 双路命中”。
 */
export function reciprocalRankFusionWithDebug(
  vectorList: ScoredChunk[],
  keywordList: ScoredChunk[],
  k = 60,
): ScoredChunk[] {
  const vectorRank = new Map(vectorList.map((hit, rank) => [hit.id, rank] as const));
  const keywordRank = new Map(keywordList.map((hit, rank) => [hit.id, rank] as const));
  const vectorScore = new Map(vectorList.map((hit) => [hit.id, hit] as const));
  const keywordScore = new Map(keywordList.map((hit) => [hit.id, hit] as const));
  const fused = reciprocalRankFusion(
    [vectorList, keywordList].filter((l) => l.length > 0),
    k,
  );
  return fused.map((hit) => {
    const vr = vectorRank.get(hit.id) ?? null;
    const kr = keywordRank.get(hit.id) ?? null;
    const vs = vectorScore.get(hit.id)?.score ?? null;
    const ks = keywordScore.get(hit.id)?.score ?? null;
    const channels: ScoredChunkDebug["channels"] = [
      ...(vr !== null ? ["vector" as const] : []),
      ...(kr !== null ? ["keyword" as const] : []),
    ];
    return {
      ...hit,
      debug: {
        vectorScore: vs,
        vectorRank: vr,
        keywordScore: ks,
        keywordRank: kr,
        rrfScore: hit.score,
        channels,
      },
    };
  });
}

/** 带引用格式，可直接拼入 system prompt。 */
export function formatChunks(chunks: ScoredChunk[]): string {
  if (chunks.length === 0) return "";
  return chunks
    .map((c) => `【来源: ${c.source} · 第${c.chunkIndex + 1}段】\n${c.content}`)
    .join("\n\n");
}
