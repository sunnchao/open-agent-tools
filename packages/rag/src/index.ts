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
import type {
  Chunk,
  ChunkInfo,
  ChunkStrategy,
  DocumentInfo,
  DocumentMetadataPatch,
  GraphChannelSource,
  IngestResult,
  RetrievalResult,
  VectorStore,
} from "./types.js";

export type {
  ChannelHit,
  Chunk,
  ChunkStrategy,
  ScoredChunk,
  ScoredChunkDebug,
  RetrievalChannel,
  RetrievalDebug,
  GraphChannelHit,
  GraphAugmentation,
  GraphChannelSource,
  ChunkInfo,
  DocumentInfo,
  DocumentMetadataPatch,
  DocumentWriteMetadata,
  RetrievalResult,
  IngestResult,
  VectorStore,
  DocumentLoader,
  OcrStatus,
} from "./types.js";
export { SqliteVectorStore, type SqliteStoreOptions } from "./store.js";
export {
  ElasticsearchVectorStore,
  buildKeywordQuery,
  buildKnnFilter,
  type ElasticsearchStoreOptions,
} from "./store-elasticsearch.js";
export {
  reciprocalRankFusion,
  reciprocalRankFusionWithDebug,
  fuseChannelHits,
  formatChunks,
  type RetrieveOptions,
} from "./retriever.js";
export { cosine, escapeFtsQuery, sha1 } from "./utils.js";
export { TextFileLoader, PdfFileLoader } from "./loaders.js";
export { DEFAULT_SEPARATORS, normalizeSource } from "./ingest.js";
export {
  cleanOcrText,
  DEFAULT_OCR_DECISION,
  FakeOcrProvider,
  isLikelyScanned,
  normalizeOcrDecision,
  NoopOcrProvider,
  type OcrDecision,
  type OcrPage,
  type OcrProvider,
} from "./ocr.js";
export { TesseractOcrProvider, type TesseractOcrOptions } from "./ocr-tesseract.js";

export interface RagOptions {
  /** 必填时启用向量检索；缺省则退化为纯 BM25 关键词检索（无 API Key 环境可用）。 */
  embeddings?: EmbeddingsInterface;
  /** SQLite 数据库文件路径，默认 ./rag.db。传入 `store` 时忽略。 */
  dbPath?: string;
  /** 注入存储后端：缺省为 SQLite；传 `ElasticsearchVectorStore` 即切换到 ES。 */
  store?: VectorStore;
  chunkSize?: number;
  chunkOverlap?: number;
  chunkStrategy?: ChunkStrategy;
  separators?: string[];
  /** 语义切分相似度阈值（0-1），仅在提供 embeddings 时生效。 */
  semanticThreshold?: number;
  /** PDF OCR 兜底提供方；缺省为诊断模式（检出疑似扫描但不识别）。 */
  ocr?: import("./ocr.js").OcrProvider;
  ocrDecision?: Partial<import("./ocr.js").OcrDecision>;
  /** 知识图谱通道数据源；缺省不启用图谱召回（两路行为不变）。 */
  graph?: GraphChannelSource;
  /** 图谱子图扩展跳数，默认 2。 */
  graphHops?: number;
}

/** Rag 门面接受的检索选项：graph 同时支持布尔开关与直接注入数据源（核心 retrieve 只认数据源）。 */
export type RagRetrieveOptions = Omit<RetrieveOptions, "graph"> & {
  /**
   * `false` 显式关闭图谱通道；`true`/缺省使用构造注入的 graph；
   * 传入 `GraphChannelSource` 则本次调用临时覆盖构造注入的实例。
   */
  graph?: GraphChannelSource | boolean;
};

/** RAG 引擎门面：入库 + 混合检索 + 知识库管理。存储后端可为同步（SQLite）或异步（ES），门面一律 async。 */
export class Rag {
  private store: VectorStore;
  private ingestOpts: IngestOptions;
  private graph?: GraphChannelSource;
  private graphHops: number;

  constructor(opts: RagOptions = {}) {
    this.store = opts.store ?? new SqliteVectorStore({ dbPath: opts.dbPath ?? "./rag.db" });
    this.graph = opts.graph;
    this.graphHops = opts.graphHops ?? 2;
    this.ingestOpts = {
      store: this.store,
      embeddings: opts.embeddings,
      chunkSize: opts.chunkSize ?? 500,
      chunkOverlap: opts.chunkOverlap ?? 50,
      chunkStrategy: opts.chunkStrategy ?? "fixed",
      separators: opts.separators ? [...opts.separators] : [...DEFAULT_SEPARATORS],
      semanticThreshold: opts.semanticThreshold,
      ocr: opts.ocr,
      ocrDecision: opts.ocrDecision,
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
    options: Pick<
      IngestOptions,
      | "chunkSize"
      | "chunkOverlap"
      | "chunkStrategy"
      | "separators"
      | "semanticThreshold"
      | "ocr"
      | "ocrDecision"
    > = {},
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

  /** 混合检索：向量 kNN + FTS5 BM25（+ 可选图谱通道）→ RRF → Top-K。 */
  async retrieve(query: string, opts: RagRetrieveOptions = {}): Promise<RetrievalResult> {
    const { graph: requested, ...rest } = opts;
    const sources = await this.resolveVisibleSources(rest.sources, rest.viewerGroups);
    // 显式 false 关闭；true/缺省回落到构造时注入的数据源（兼容按布尔开关调用的上层）。
    const graph =
      requested === false
        ? false
        : requested === true || requested === undefined
          ? this.graph
          : requested;
    const coreOpts: RetrieveOptions = {
      ...rest,
      sources,
      graphHops: rest.graphHops ?? this.graphHops,
      ...(graph !== undefined ? { graph } : {}),
    };
    return retrieve(this.store, this.ingestOpts.embeddings, query, coreOpts);
  }

  /**
   * 按 chunk id 批量回取真实分块（图谱回溯用）。
   * store 未实现该能力时返回 []，让调用方的图谱通道自然降级为空候选。
   */
  async getChunksByIds(ids: readonly string[], sources?: readonly string[]): Promise<Chunk[]> {
    if (ids.length === 0) return [];
    if (sources?.length === 0) return [];
    if (!this.store.getChunksByIds) return [];
    return this.store.getChunksByIds(ids, sources);
  }

  /**
   * 将「请求来源 + 文档 ACL」收敛为实际可检索的来源白名单。
   *
   * - viewerGroups 缺省：管理侧上下文，不启用 ACL；
   * - viewerGroups 为 []：只返回无分组限制的文档；
   * - 分组含 "*"：等同管理侧，可见全部文档；
   * - sources 缺省：全库范围内按 ACL 过滤；显式 [] 则仍为不检索。
   */
  async resolveVisibleSources(
    sources: readonly string[] | undefined,
    viewerGroups: readonly string[] | undefined,
  ): Promise<string[] | undefined> {
    if (sources?.length === 0) return [];
    // 管理侧且未限定来源时保持原来的「全库」语义，不枚举文档。
    if (viewerGroups === undefined && !sources) return undefined;
    const unrestricted = viewerGroups === undefined || viewerGroups.includes("*");
    const documents = await this.store.listDocuments();
    const visible = documents
      .filter(
        (document) =>
          unrestricted ||
          document.allowedGroups.length === 0 ||
          document.allowedGroups.some((group) => viewerGroups?.includes(group)),
      )
      .map((document) => document.source);
    if (!sources) return visible;
    const visibleSet = new Set(visible);
    return [...new Set(sources)].filter((source) => visibleSet.has(source));
  }

  /** 列出某来源的全部分块元信息（id、序号、原文、长度、是否含向量）。 */
  async listChunks(source: string): Promise<ChunkInfo[]> {
    if (!this.store.listChunksBySource) return [];
    return this.store.listChunksBySource(source);
  }

  async listSources(): Promise<string[]> {
    return this.store.listSources();
  }

  async listDocuments(): Promise<DocumentInfo[]> {
    return this.store.listDocuments();
  }

  async updateDocument(source: string, patch: DocumentMetadataPatch): Promise<DocumentInfo | null> {
    return this.store.updateDocument(source, patch);
  }

  async clearSource(source: string): Promise<void> {
    await this.store.removeBySource(source);
  }

  async getStats(): Promise<{ chunks: number; sources: string[] }> {
    const [chunks, sources] = await Promise.all([
      this.store.countChunks(),
      this.store.listSources(),
    ]);
    return { chunks, sources };
  }

  async close(): Promise<void> {
    await this.store.close?.();
  }
}
