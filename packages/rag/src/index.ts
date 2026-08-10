import type { EmbeddingsInterface } from "@langchain/core/embeddings";
import { SqliteVectorStore } from "./store.js";
import {
  DEFAULT_SEPARATORS,
  ingestBuffer,
  ingestMany,
  normalizeSource,
  type IngestOptions,
} from "./ingest.js";
import { retrieve, type RetrieveOptions } from "./retriever.js";
import type { ChunkInfo, IngestResult, RetrievalResult } from "./types.js";

export type {
  Chunk,
  ScoredChunk,
  ChunkInfo,
  RetrievalResult,
  IngestResult,
  VectorStore,
  DocumentLoader,
} from "./types.js";
export { SqliteVectorStore, type SqliteStoreOptions } from "./store.js";
export { reciprocalRankFusion, formatChunks, type RetrieveOptions } from "./retriever.js";
export { cosine, escapeFtsQuery, sha1 } from "./utils.js";
export { TextFileLoader, PdfFileLoader } from "./loaders.js";
export { DEFAULT_SEPARATORS, normalizeSource } from "./ingest.js";

export interface RagOptions {
  /** 必填时启用向量检索；缺省则退化为纯 BM25 关键词检索（无 API Key 环境可用）。 */
  embeddings?: EmbeddingsInterface;
  /** SQLite 数据库文件路径，默认 ./rag.db。 */
  dbPath?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  separators?: string[];
  /** 语义切分相似度阈值（0-1），仅在提供 embeddings 时生效。 */
  semanticThreshold?: number;
}

/** RAG 引擎门面：入库 + 混合检索 + 知识库管理。 */
export class Rag {
  private store: SqliteVectorStore;
  private ingestOpts: IngestOptions;

  constructor(opts: RagOptions = {}) {
    this.store = new SqliteVectorStore({ dbPath: opts.dbPath ?? "./rag.db" });
    this.ingestOpts = {
      store: this.store,
      embeddings: opts.embeddings,
      chunkSize: opts.chunkSize ?? 500,
      chunkOverlap: opts.chunkOverlap ?? 50,
      separators: opts.separators ? [...opts.separators] : [...DEFAULT_SEPARATORS],
      semanticThreshold: opts.semanticThreshold,
    };
  }

  /** 从本地路径批量入库，幂等（同 source 先清后写）。 */
  async ingestFiles(paths: string[]): Promise<IngestResult> {
    return ingestMany(paths, this.ingestOpts);
  }

  /**
   * 从内存 Buffer 入库（Web 上传），幂等。
   * 返回的 sources 是本次上传的来源，不是全库清单——图谱重建按此增量触发。
   */
  async ingestBuffers(
    files: Array<{ name: string; data: Uint8Array }>,
    options: Pick<IngestOptions, "chunkSize" | "chunkOverlap" | "separators"> = {},
  ): Promise<IngestResult> {
    const ingestOptions = { ...this.ingestOpts, ...options };
    let total = 0;
    for (const f of files) {
      total += await ingestBuffer(f.name, f.data, ingestOptions);
    }
    return {
      files: files.length,
      chunks: total,
      sources: [...new Set(files.map((f) => normalizeSource(f.name)))],
    };
  }

  /** 混合检索：向量 kNN + FTS5 BM25 → RRF → Top-K。 */
  async retrieve(query: string, opts: RetrieveOptions = {}): Promise<RetrievalResult> {
    return retrieve(this.store, this.ingestOpts.embeddings, query, opts);
  }

  /** 列出某来源的全部分块元信息（id、序号、原文、长度、是否含向量）。 */
  listChunks(source: string): ChunkInfo[] {
    return this.store.listChunksBySource(source);
  }

  listSources(): string[] {
    return this.store.listSources();
  }

  clearSource(source: string): void {
    this.store.removeBySource(source);
  }

  getStats(): { chunks: number; sources: string[] } {
    return { chunks: this.store.countChunks(), sources: this.store.listSources() };
  }

  close(): void {
    this.store.close();
  }
}
