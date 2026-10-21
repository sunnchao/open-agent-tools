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

/** 带相关性得分的检索命中。score 为 RRF 融合分；debug 保留双路原始分用于排查。 */
export interface ScoredChunk extends Chunk {
  score: number;
  /** 双路明细：任一通道未命中时对应分/排名为 null。 */
  debug?: ScoredChunkDebug;
}

/** 单个命中在双路中的来源明细。 */
export interface ScoredChunkDebug {
  vectorScore: number | null;
  /** 在向量候选中的排名（0 起）；未命中为 null。 */
  vectorRank: number | null;
  keywordScore: number | null;
  /** 在关键词候选中的排名（0 起）；未命中为 null。 */
  keywordRank: number | null;
  /** RRF 融合分（与 ScoredChunk.score 一致）。 */
  rrfScore: number;
  /** 命中通道：vector / keyword / 双路。 */
  channels: Array<"vector" | "keyword">;
}

/** 单路原始命中（融合前，native 分数：向量余弦 / BM25）。 */
export interface ChannelHit extends Chunk {
  score: number;
  rank: number;
}

/** 混合检索链路明细：审计与前端“区分向量/关键词”展示的数据源。 */
export interface RetrievalDebug {
  embeddingsEnabled: boolean;
  candidates: number;
  rrfK: number;
  timingsMs: {
    vectorMs: number | null;
    keywordMs: number;
    fusionMs: number;
  };
  /** 融合前的向量 Top（native 余弦分 + rank）。无 embeddings 时为空。 */
  vectorHits: ChannelHit[];
  /** 融合前的关键词 Top（native BM25 分 + rank）。 */
  keywordHits: ChannelHit[];
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
  /** 双路明细：向量/关键词原始分、排名、耗时。审计日志按 queryId 持久化它。 */
  debug?: RetrievalDebug;
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
  close?(): MaybePromise<void>;
}

/** 文档加载器：支持路径与内存 Buffer 两种来源（Web 上传场景）。 */
export interface DocumentLoader {
  load(path: string): Promise<Document[]>;
  loadBuffer(name: string, data: Uint8Array): Promise<Document[]>;
}
