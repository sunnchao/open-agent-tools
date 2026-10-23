import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import type {
  ChannelHit,
  Chunk,
  GraphAugmentation,
  GraphChannelHit,
  GraphChannelSource,
  RetrievalChannel,
  RetrievalDebug,
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
  /**
   * 知识图谱通道：传入数据源即启用第三路召回，传 `false` 显式关闭。
   * 图谱异常只会降级为空候选，不影响向量/关键词两路。
   */
  graph?: GraphChannelSource | false;
  /** 图谱子图扩展跳数，默认 2。 */
  graphHops?: number;
  /**
   * 关键词（BM25）通道开关，默认 `true`。
   * 传 `false` 时只保留向量召回，用于「仅向量」检索模式。
   */
  keyword?: boolean;
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

/** 单通道命中在融合前的排名与原始分。 */
interface ChannelAccumulator {
  ranks: Map<string, number>;
  scores: Map<string, number>;
}

/**
 * N 路 RRF 融合：每路按自身排名贡献 1/(k+rank+1)，按 id 合并同一条分块。
 *
 * channels 里的顺序决定 debug.channels 的展示顺序（vector → keyword → graph）；
 * 传入的通道集合也决定 debug 字段的形状——不含 graph 时不写 graphScore/graphRank，
 * 保证旧的两路调用方拿到的 debug 与改造前逐字段一致。
 */
export function fuseChannelHits(
  channels: Array<{ channel: RetrievalChannel; hits: ScoredChunk[] }>,
  k = 60,
): ScoredChunk[] {
  const accumulators = new Map<RetrievalChannel, ChannelAccumulator>();
  for (const { channel, hits } of channels) {
    const accumulator = accumulators.get(channel) ?? {
      ranks: new Map<string, number>(),
      scores: new Map<string, number>(),
    };
    hits.forEach((hit, rank) => {
      // 与旧 `new Map(list.map(...))` 保持一致：重复 id 取最后一次出现的排名与分值。
      accumulator.ranks.set(hit.id, rank);
      accumulator.scores.set(hit.id, hit.score);
    });
    accumulators.set(channel, accumulator);
  }
  const fused = reciprocalRankFusion(
    channels.filter((c) => c.hits.length > 0).map((c) => c.hits),
    k,
  );
  const hasGraph = channels.some((c) => c.channel === "graph");
  return fused.map((hit) => {
    const vector = accumulators.get("vector");
    const keyword = accumulators.get("keyword");
    const graph = accumulators.get("graph");
    const vr = vector?.ranks.get(hit.id) ?? null;
    const kr = keyword?.ranks.get(hit.id) ?? null;
    const gr = graph?.ranks.get(hit.id) ?? null;
    const debug: ScoredChunkDebug = {
      vectorScore: vector?.scores.get(hit.id) ?? null,
      vectorRank: vr,
      keywordScore: keyword?.scores.get(hit.id) ?? null,
      keywordRank: kr,
      ...(hasGraph ? { graphScore: graph?.scores.get(hit.id) ?? null, graphRank: gr } : {}),
      rrfScore: hit.score,
      channels: [
        ...(vr !== null ? ["vector" as const] : []),
        ...(kr !== null ? ["keyword" as const] : []),
        ...(gr !== null ? ["graph" as const] : []),
      ],
    };
    return { ...hit, debug };
  });
}

/**
 * 混合检索：向量 kNN（若有 embeddings）+ FTS5 BM25 + 可选图谱通道 → RRF 融合 → Top-K。
 * 无 embeddings 时退化为纯关键词检索；图谱通道未注入时行为与两路版本完全一致。
 *
 * 返回的 chunks.score 为 RRF 融合分；chunks[].debug 与 result.debug 保留各路
 * 原始分（向量余弦 / BM25 / 图谱权重）与排名，供前端区分展示与审计回溯。
 */
export async function retrieve(
  store: VectorStore,
  embeddings: EmbeddingsInterface | undefined,
  query: string,
  opts: RetrieveOptions = {},
): Promise<RetrievalResult> {
  const { topK = 5, candidates = 30, rrfK = 60, sources, graphHops = 2 } = opts;
  const graphSource = opts.graph === false ? undefined : opts.graph;
  const keywordEnabled = opts.keyword !== false;
  if (sources?.length === 0) {
    return {
      query,
      chunks: [],
      formatted: () => "",
      ...(graphSource ? { graph: emptyGraphAugmentation() } : {}),
    };
  }
  let vectorList: ScoredChunk[] = [];
  let vectorMs: number | null = null;
  const vectorTask = (async () => {
    if (!embeddings) return;
    const started = Date.now();
    const qv = (await embeddings.embedDocuments([query]))[0] ?? [];
    vectorList = await store.vectorSearch(qv, candidates, sources);
    vectorMs = Date.now() - started;
  })();
  let keywordList: ScoredChunk[] = [];
  let keywordMs = 0;
  const keywordTask = (async () => {
    if (!keywordEnabled) return;
    const keywordStarted = Date.now();
    keywordList = await store.keywordSearch(query, candidates, sources); // store 内部做 CJK 切分 + AND→OR 降级
    keywordMs = Date.now() - keywordStarted;
  })();

  // 图谱通道独立计时与降级：图数据库故障不应把整次知识库检索拖垮。
  let graphList: GraphChannelHit[] = [];
  let graphMs: number | null = null;
  let graphAugmentation: GraphAugmentation | undefined;
  const graphTask = (async () => {
    if (!graphSource) return;
    const graphStarted = Date.now();
    graphAugmentation = emptyGraphAugmentation();
    try {
      const graphResult = await graphSource.retrieve(query, { maxHops: graphHops, sources });
      const seeds = graphResult.seeds ?? [];
      const seedSummary = seeds.map((seed) => ({ id: seed.id, name: seed.name, type: seed.type }));
      const subgraph = graphResult.subgraph;
      if (subgraph) {
        // 先把子图事实记下来：即便下面的分块回取失败，prompt 仍能用上子图上下文。
        graphAugmentation = {
          enabled: true,
          seeds: seedSummary,
          context: subgraph.formatted(),
          entities: subgraph.entities.length,
          relations: subgraph.relations.length,
          chunkHits: 0,
        };
        const graphCandidates = rankGraphChunkCandidates(subgraph.relations, seeds, candidates);
        try {
          const ids = graphCandidates.map((candidate) => candidate.chunkId);
          const chunks =
            ids.length === 0
              ? []
              : graphSource.getChunksByIds
                ? await graphSource.getChunksByIds(ids, sources)
                : ((await store.getChunksByIds?.(ids, sources)) ?? []);
          graphList = toGraphChannelHits(graphCandidates, chunks, seedSummary, sources);
          graphAugmentation = { ...graphAugmentation, chunkHits: graphList.length };
        } catch {
          // 子图检索成功、分块回取失败：只丢图谱候选，子图上下文仍可作为 prompt 补充事实。
          graphList = [];
        }
      } else {
        graphAugmentation = { ...emptyGraphAugmentation(), seeds: seedSummary };
      }
    } catch {
      // 图谱检索本身失败：整体降级为空候选，不抛出。
      graphList = [];
      graphAugmentation = emptyGraphAugmentation();
    }
    graphMs = Date.now() - graphStarted;
  })();
  // 等待已启动的读取结束，并按原有通道顺序抛错，避免关闭 store 后仍有后台读取。
  const results = await Promise.allSettled([vectorTask, keywordTask, graphTask]);
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }

  const fusionStarted = Date.now();
  const channelsToFuse: Array<{ channel: RetrievalChannel; hits: ScoredChunk[] }> = [
    { channel: "vector", hits: vectorList },
  ];
  if (keywordEnabled) channelsToFuse.push({ channel: "keyword", hits: keywordList });
  if (graphSource) channelsToFuse.push({ channel: "graph", hits: graphList });
  const chunks = fuseChannelHits(channelsToFuse, rrfK).slice(0, topK);
  const fusionMs = Date.now() - fusionStarted;
  const debug: RetrievalDebug = {
    embeddingsEnabled: Boolean(embeddings),
    candidates,
    rrfK,
    // 仅在关闭时写字段：默认两路/三路调用的 debug 形状与改造前逐字段一致。
    ...(keywordEnabled ? {} : { keywordEnabled: false }),
    ...(graphSource ? { graphEnabled: true } : {}),
    timingsMs: {
      vectorMs,
      keywordMs,
      ...(graphSource ? { graphMs } : {}),
      fusionMs,
    },
    vectorHits: withRank(vectorList),
    keywordHits: withRank(keywordList),
    ...(graphSource ? { graphHits: graphList } : {}),
  };
  return {
    query,
    chunks,
    formatted: () => formatChunks(chunks),
    debug,
    ...(graphAugmentation ? { graph: graphAugmentation } : {}),
  };
}

function emptyGraphAugmentation(): GraphAugmentation {
  return { enabled: true, seeds: [], context: "", entities: 0, relations: 0, chunkHits: 0 };
}

/** 图谱候选在全部通道中的排名与权重分。 */
interface RankedGraphCandidate {
  chunkId: string;
  /** 归一化前的原始关系权重（同一分块取最大权重）。 */
  weight: number;
  /** 距最近种子的跳数（同一分块取最小跳数）。 */
  hop: number;
  /** 能到达该分块对应关系的种子实体 id。 */
  seedIds: string[];
  /** 子图中首次出现的顺序，仅用于稳定排序。 */
  order: number;
}

/**
 * 把子图关系回溯成 chunk id 候选。
 *
 * 关系本身没有 hop 字段，这里以种子为起点、按无向边反推每条边首次被发现时的扩展层数：
 * 越靠近种子的边越可能直接回答查询，权重越高说明同源三元组出现频次越高。
 * 同一 chunk 可能被多条边引用，按 (hop 升序, weight 降序) 取最优并合并种子。
 */
function rankGraphChunkCandidates(
  relations: ReadonlyArray<{
    sourceChunk: string;
    weight: number;
    srcId: string;
    dstId: string;
  }>,
  seeds: ReadonlyArray<{ id: string }>,
  limit: number,
): RankedGraphCandidate[] {
  const adjacency = new Map<string, Set<string>>();
  const connect = (a: string, b: string) => {
    let neighbors = adjacency.get(a);
    if (!neighbors) {
      neighbors = new Set<string>();
      adjacency.set(a, neighbors);
    }
    neighbors.add(b);
  };
  for (const relation of relations) {
    connect(relation.srcId, relation.dstId);
    connect(relation.dstId, relation.srcId);
  }

  // 每个种子单独做一次 BFS：子图有 maxNodes 上限（默认 64），
  // 换成「只记第一个到达的种子」会丢掉多种子共同解释一条边的事实，前端 seeds 就不可信了。
  const distancesBySeed = new Map<string, Map<string, number>>();
  for (const seed of seeds) {
    const distances = new Map<string, number>([[seed.id, 0]]);
    const queue = [seed.id];
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index]!;
      const depth = distances.get(current)!;
      for (const next of adjacency.get(current) ?? []) {
        if (!distances.has(next)) {
          distances.set(next, depth + 1);
          queue.push(next);
        }
      }
    }
    distancesBySeed.set(seed.id, distances);
  }

  const grouped = new Map<
    string,
    { weight: number; hop: number; seedIds: Set<string>; order: number }
  >();
  relations.forEach((relation, order) => {
    if (!relation.sourceChunk) return;
    let hop = Number.MAX_SAFE_INTEGER;
    const seedIds: string[] = [];
    for (const seed of seeds) {
      const distances = distancesBySeed.get(seed.id)!;
      const nearest = Math.min(
        distances.get(relation.srcId) ?? Number.MAX_SAFE_INTEGER,
        distances.get(relation.dstId) ?? Number.MAX_SAFE_INTEGER,
      );
      if (nearest === Number.MAX_SAFE_INTEGER) continue;
      const edgeHop = nearest + 1;
      if (edgeHop < hop) {
        hop = edgeHop;
        seedIds.length = 0;
        seedIds.push(seed.id);
      } else if (edgeHop === hop) {
        seedIds.push(seed.id);
      }
    }
    const current = grouped.get(relation.sourceChunk);
    if (!current) {
      grouped.set(relation.sourceChunk, {
        weight: relation.weight,
        hop,
        seedIds: new Set(seedIds),
        order,
      });
      return;
    }
    current.weight = Math.max(current.weight, relation.weight);
    current.hop = Math.min(current.hop, hop);
    current.order = Math.min(current.order, order);
    for (const id of seedIds) current.seedIds.add(id);
  });

  return [...grouped.entries()]
    .map(([chunkId, entry]) => ({
      chunkId,
      weight: entry.weight,
      hop: entry.hop,
      seedIds: [...entry.seedIds],
      order: entry.order,
    }))
    .sort((a, b) => a.hop - b.hop || b.weight - a.weight || a.order - b.order)
    .slice(0, limit);
}

/**
 * 组装图谱通道候选：按候选顺序回填真实分块，store 未过滤干净的来源在此二次拦截。
 * 权重归一化到 (0, 1]，方便与向量余弦/BM25 分在同一 debug 面板里横向比较。
 */
function toGraphChannelHits(
  candidates: RankedGraphCandidate[],
  chunks: Chunk[],
  seeds: ReadonlyArray<{ id: string; name: string; type: string }>,
  sources?: readonly string[],
): GraphChannelHit[] {
  if (candidates.length === 0 || chunks.length === 0) return [];
  const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk] as const));
  const sourceSet = sources ? new Set(sources) : null;
  const seedNameById = new Map(seeds.map((seed) => [seed.id, seed.name] as const));
  const maxWeight = Math.max(...candidates.map((candidate) => candidate.weight), 0);
  const hits: GraphChannelHit[] = [];
  for (const candidate of candidates) {
    const chunk = chunkById.get(candidate.chunkId);
    if (!chunk) continue;
    if (sourceSet && !sourceSet.has(chunk.source)) continue;
    hits.push({
      id: chunk.id,
      source: chunk.source,
      chunkIndex: chunk.chunkIndex,
      content: chunk.content,
      score: maxWeight > 0 ? candidate.weight / maxWeight : 0,
      rank: hits.length,
      seeds: candidate.seedIds
        .map((id) => seedNameById.get(id))
        .filter((name): name is string => typeof name === "string"),
    });
  }
  return hits;
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
 * 保留原签名供既有调用方使用；实现委托给通用的 `fuseChannelHits`。
 */
export function reciprocalRankFusionWithDebug(
  vectorList: ScoredChunk[],
  keywordList: ScoredChunk[],
  k = 60,
): ScoredChunk[] {
  return fuseChannelHits(
    [
      { channel: "vector", hits: vectorList },
      { channel: "keyword", hits: keywordList },
    ],
    k,
  );
}

/** 带引用格式，可直接拼入 system prompt。 */
export function formatChunks(chunks: ScoredChunk[]): string {
  if (chunks.length === 0) return "";
  return chunks
    .map((c) => `【来源: ${c.source} · 第${c.chunkIndex + 1}段】\n${c.content}`)
    .join("\n\n");
}
