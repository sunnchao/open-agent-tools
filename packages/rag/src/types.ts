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

/** 带相关性得分的检索命中。score 越大越相关（RRF 融合后为 RRF 分）。 */
export interface ScoredChunk extends Chunk {
  score: number;
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
  createdAt: string;
  updatedAt: string;
}

export interface DocumentWriteMetadata {
  mimeType: string;
  byteSize: number;
  contentHash: string;
  chunkStrategy: ChunkStrategy;
  chunkSize: number;
  chunkOverlap: number;
  separators: string[];
  semanticThreshold: number | null;
}

export interface DocumentMetadataPatch {
  title?: string;
  tags?: string[];
}

export interface RetrievalResult {
  query: string;
  chunks: ScoredChunk[];
  /** 带引用格式的上下文文本，可直接拼入 system prompt。 */
  formatted(): string;
}

export interface IngestResult {
  /** 本次入库文件数。 */
  files: number;
  /** 本次入库分块总数。 */
  chunks: number;
  /** 入库后的全部知识来源。 */
  sources: string[];
}

/** 存储后端接口：换 Elasticsearch / seekdb 时新增实现即可，调用方 API 不变。 */
export interface VectorStore {
  insert(chunk: Chunk, embedding: Float32Array): void;
  replaceSource(
    source: string,
    rows: Array<{ chunk: Chunk; embedding: Float32Array }>,
    metadata: DocumentWriteMetadata,
  ): void;
  vectorSearch(embedding: number[], k: number, sources?: readonly string[]): ScoredChunk[];
  keywordSearch(query: string, k: number, sources?: readonly string[]): ScoredChunk[];
  removeBySource(source: string): void;
  listSources(): string[];
  listDocuments(): DocumentInfo[];
  updateDocument(source: string, patch: DocumentMetadataPatch): DocumentInfo | null;
  countChunks(): number;
}

/** 文档加载器：支持路径与内存 Buffer 两种来源（Web 上传场景）。 */
export interface DocumentLoader {
  load(path: string): Promise<Document[]>;
  loadBuffer(name: string, data: Uint8Array): Promise<Document[]>;
}
