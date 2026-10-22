import type { Document } from "@langchain/core/documents";

export type ChunkStrategy = "fixed" | "semantic";

/** 知识库分块。id 为稳定唯一键（sha1(source:chunkIndex)）。 */
export interface Chunk {
  id: string;
  /** 文档标识（文件名 / 相对路径）。 */
  source: string;
  /** 文档内分块序号，从 0 开始。 */
  chunkIndex: number;
  /** 分块原文。 */
  content: string;
}

/** 检索通道：向量 kNN / BM25 关键词 / 知识图谱子图回溯。 */
export type RetrievalChannel = "vector" | "keyword" | "graph";

/** 带相关性得分的检索命中。score 为 RRF 融合分；debug 保留各通道原始分用于排查。 */
export interface ScoredChunk extends Chunk {
  score: number;
  /** 多路明细：任一通道未命中时对应分/排名为 null。 */
  debug?: ScoredChunkDebug;
}

/** 单个命中在各检索通道中的来源明细。 */
export interface ScoredChunkDebug {
  vectorScore: number | null;
  /** 在向量候选中的排名（0 起）；未命中为 null。 */
  vectorRank: number | null;
  keywordScore: number | null;
  /** 在关键词候选中的排名（0 起）；未命中为 null。 */
  keywordRank: number | null;
  /** 图谱候选的归一化权重分；图谱通道未启用时缺省。 */
  graphScore?: number | null;
  /** 在图谱候选中的排名（0 起）；未命中为 null。 */
  graphRank?: number | null;
  /** RRF 融合分（与 ScoredChunk.score 一致）。 */
  rrfScore: number;
  /** 命中通道，按 vector → keyword → graph 的固定顺序排列。 */
  channels: RetrievalChannel[];
}

/** 单路原始命中（融合前，native 分数：向量余弦 / BM25 / 图谱权重分）。 */
export interface ChannelHit extends Chunk {
  score: number;
  rank: number;
}

/** 图谱通道候选：在 ChannelHit 之上记录命中的种子实体名，便于前端解释召回来源。 */
export interface GraphChannelHit extends ChannelHit {
  seeds: string[];
}

/** 图谱增强结果：子图上下文供 prompt 使用，不参与 citation。 */
export interface GraphAugmentation {
  enabled: boolean;
  seeds: Array<{ id: string; name: string; type: string }>;
  /** 子图序列化文本（三元组 + 实体属性），可直接拼入 system prompt。 */
  context: string;
  entities: number;
  relations: number;
  /** 回溯到真实分块并进入 RRF 的候选数。 */
  chunkHits: number;
}

/** 混合检索链路明细：审计与前端“区分向量/关键词/图谱”展示的数据源。 */
export interface RetrievalDebug {
  embeddingsEnabled: boolean;
  candidates: number;
  rrfK: number;
  /** 是否启用关键词（BM25）通道；仅显式关闭时写 false（保持旧 debug 形状）。 */
  keywordEnabled?: boolean;
  /** 是否启用图谱通道；未注入 graph 时缺省（保持旧 debug 形状）。 */
  graphEnabled?: boolean;
  timingsMs: {
    vectorMs: number | null;
    keywordMs: number;
    graphMs?: number | null;
    fusionMs: number;
  };
  /** 融合前的向量 Top（native 余弦分 + rank）。无 embeddings 时为空。 */
  vectorHits: ChannelHit[];
  /** 融合前的关键词 Top（native BM25 分 + rank）。 */
  keywordHits: ChannelHit[];
  /** 融合前的图谱候选（按 hop/weight 排序）。未启用图谱时缺省。 */
  graphHits?: GraphChannelHit[];
}

/** 分块元信息（含向量是否存在），用于"查看文件分块详情"等场景。 */
export interface ChunkInfo extends Chunk {
  /** 原文长度（字符数）。 */
  length: number;
  /** 该分块是否已写入 embedding（无 API Key 退化为 BM25 时为 false）。 */
  hasEmbedding: boolean;
}

/** 可运营的知识文档目录信息。source 仍是稳定检索标识，title/tags 供管理端维护。 */
export interface DocumentInfo {
  source: string;
  title: string;
  tags: string[];
  /** 可额外查看该文档的分组；空数组表示公开给所有调用方。 */
  allowedGroups: string[];
  mimeType: string;
  byteSize: number;
  contentHash: string;
  chunks: number;
  version: number;
  chunkStrategy: ChunkStrategy;
  chunkSize: number;
  chunkOverlap: number;
  separators: string[];
  semanticThreshold: number | null;
  /** 是否经 OCR 兜底生成（文本层优先，扫描件才为 true）。 */
  ocrApplied: boolean;
  /** none | text_layer | ocr | ocr_needed | ocr_failed，与 documents.ocr_status 对应。 */
  ocrStatus: OcrStatus;
  createdAt: string;
  updatedAt: string;
}

export type OcrStatus = "none" | "text_layer" | "ocr" | "ocr_needed" | "ocr_failed";

export interface DocumentWriteMetadata {
  mimeType: string;
  byteSize: number;
  contentHash: string;
  chunkStrategy: ChunkStrategy;
  chunkSize: number;
  chunkOverlap: number;
  separators: string[];
  semanticThreshold: number | null;
  /** 可选：调用方未知时由 ingest 按页文本自动推导，缺省为 false/none。 */
  ocrApplied?: boolean;
  ocrStatus?: OcrStatus;
  ocrPages?: number;
}

export interface DocumentMetadataPatch {
  title?: string;
  tags?: string[];
  allowedGroups?: string[];
}

export interface RetrievalResult {
  query: string;
  chunks: ScoredChunk[];
  /** 带引用格式的上下文文本，可直接拼入 system prompt。 */
  formatted(): string;
  /** 多路明细：各通道原始分、排名、耗时。审计日志按 queryId 持久化它。 */
  debug?: RetrievalDebug;
  /** 图谱增强结果；图谱通道启用时存在（即使零命中也如实标记 enabled）。 */
  graph?: GraphAugmentation;
}

/**
 * 图谱通道数据源（由调用方注入，通常包装 KnowledgeGraph）。
 * 只暴露检索所需的最小面：子图检索 + 按 id 回取真实分块。
 */
export interface GraphChannelSource {
  retrieve(
    query: string,
    opts?: { maxHops?: number; maxNodes?: number; sources?: readonly string[] },
  ): Promise<{
    seeds: Array<{ id: string; name: string; type: string }>;
    subgraph: {
      entities: Array<{ id: string; name: string; type: string }>;
      relations: Array<{ sourceChunk: string; weight: number; srcId: string; dstId: string }>;
      formatted(): string;
    } | null;
  }>;
  getChunksByIds(ids: readonly string[], sources?: readonly string[]): Promise<Chunk[]>;
}

export interface IngestResult {
  /** 本次入库文件数。 */
  files: number;
  /** 本次入库分块总数。 */
  chunks: number;
  /** 入库后的全部知识来源。 */
  sources: string[];
}

/** 存储后端可能是同步（SQLite）或异步（Elasticsearch）：调用方一律 `await`。 */
export type MaybePromise<T> = T | Promise<T>;

/** 存储后端接口：SQLite / Elasticsearch 均实现它，调用方 API 不变。 */
export interface VectorStore {
  insert(chunk: Chunk, embedding: Float32Array): MaybePromise<void>;
  replaceSource(
    source: string,
    rows: Array<{ chunk: Chunk; embedding: Float32Array }>,
    metadata: DocumentWriteMetadata,
  ): MaybePromise<void>;
  vectorSearch(
    embedding: number[],
    k: number,
    sources?: readonly string[],
  ): MaybePromise<ScoredChunk[]>;
  keywordSearch(query: string, k: number, sources?: readonly string[]): MaybePromise<ScoredChunk[]>;
  removeBySource(source: string): MaybePromise<void>;
  listSources(): MaybePromise<string[]>;
  listDocuments(): MaybePromise<DocumentInfo[]>;
  updateDocument(source: string, patch: DocumentMetadataPatch): MaybePromise<DocumentInfo | null>;
  countChunks(): MaybePromise<number>;
  /** 某来源全部分块（含是否含向量标记）；SQLite/ES 均提供，Rag 门面依赖它。 */
  listChunksBySource?(source: string): MaybePromise<ChunkInfo[]>;
  /**
   * 按 id 批量回取真实分块（图谱关系回溯用）。
   * sources 白名单必须下推到存储层：空数组返回 []，未实现时调用方降级为无图谱候选。
   */
  getChunksByIds?(ids: readonly string[], sources?: readonly string[]): MaybePromise<Chunk[]>;
  close?(): MaybePromise<void>;
}

/** 文档加载器：支持路径与内存 Buffer 两种来源（Web 上传场景）。 */
export interface DocumentLoader {
  load(path: string): Promise<Document[]>;
  loadBuffer(name: string, data: Uint8Array): Promise<Document[]>;
}
