/**
 * Elasticsearch 版 VectorStore 实现。
 *
 * 与 `SqliteVectorStore` 实现同一份 `VectorStore` 接口（见 `types.ts`），
 * 调用方（`ingest.ts / retriever.ts / Rag 门面`）无需改检索语义即可切换：
 *   - `chunks` 索引：原文 `content(text)` + 向量 `embedding(dense_vector,cosine)` + `source(keyword)` 过滤；
 *   - `documents` 索引：文档目录（含标题/标签/ACL/版本/切分参数/OCR 标记），与 SQLite `documents` 表一一对应。
 *
 * 设计取舍（诚实声明）：
 * 1. ES 无本地事务，`replaceSource` 是 `delete_by_query + bulk + upsert` 三步 best-effort，
 *    不如 SQLite 的 `BEGIN IMMEDIATE … COMMIT` 原子；embedding 失败时可能残留半写，需重传修复。
 * 2. `dense_vector.dims` 建索引时固定（默认 1536，即 `text-embedding-3-small`）。
 *    换 embedding 模型导致维度变化时必须重建索引（删索引重跑 `ensureIndices`），否则 `knn` 会 400。
 * 3. 中文分词默认 `standard`（单字级别可用，精度一般）；生产中文建议给 ES 装 `analysis-ik`
 *    插件后把 `content` 改为 `ik_max_word`，本文件保留 `analyzer` 注释开关，见 `CHUNKS_MAPPING`。
 */
import { Client, type ClientOptions } from "@elastic/elasticsearch";
import type {
  Chunk,
  ChunkInfo,
  DocumentInfo,
  DocumentMetadataPatch,
  DocumentWriteMetadata,
  ScoredChunk,
  VectorStore,
} from "./types.js";

export interface ElasticsearchStoreOptions {
  /** ES 节点地址，默认 `http://localhost:9200`（与 `RAG_ES_NODE` 对应）。 */
  node?: string;
  /** 外部注入的客户端（测试复用 / 复用已有连接池时用）；传入后 `close()` 不会自动关闭它。 */
  client?: Client;
  /** 透传给官方客户端的额外选项（auth、tls、requestTimeout 等）。 */
  clientOptions?: Omit<ClientOptions, "node" | "nodes">;
  /** 索引名前缀，实际索引为 `<prefix>-chunks` / `<prefix>-documents`，默认 `rag`。 */
  indexPrefix?: string;
  /**
   * 向量维度。缺省 1536。
   * 首次建索引时若还没见过非空向量就用它；见过非空向量则以实际维度为准。
   */
  dims?: number;
  /**
   * 写后刷新策略。默认 `true`（单机演示立即可见）；
   * 大批量导入时可设 `false` 提速，但测试/上传后立刻检索可能读不到。
   */
  refresh?: boolean | "wait_for";
}

const DEFAULT_DIMS = 1536;
const MAX_WINDOW = 10000;

function indexNames(prefix: string): { chunks: string; documents: string } {
  const p = prefix.trim() || "rag";
  return { chunks: `${p}-chunks`, documents: `${p}-documents` };
}

function chunksMapping(dims: number): Record<string, unknown> {
  return {
    properties: {
      id: { type: "keyword" },
      source: { type: "keyword" },
      chunk_index: { type: "integer" },
      // 生产中文：ES 装好 analysis-ik 后把 analyzer 换成 ik_max_word，search_analyzer 换 ik_smart。
      content: { type: "text", analyzer: "standard" },
      embedding: { type: "dense_vector", dims, index: true, similarity: "cosine" },
    },
  };
}

function documentsMapping(): Record<string, unknown> {
  return {
    properties: {
      source: { type: "keyword" },
      title: { type: "keyword" },
      tags: { type: "keyword" },
      allowed_groups: { type: "keyword" },
      mime_type: { type: "keyword" },
      byte_size: { type: "long" },
      content_hash: { type: "keyword" },
      chunk_count: { type: "integer" },
      version: { type: "integer" },
      chunk_strategy: { type: "keyword" },
      chunk_size: { type: "integer" },
      chunk_overlap: { type: "integer" },
      separators: { type: "keyword" },
      semantic_threshold: { type: "float" },
      ocr_applied: { type: "boolean" },
      ocr_status: { type: "keyword" },
      created_at: { type: "date" },
      updated_at: { type: "date" },
    },
  };
}

function isIndexNotFound(error: unknown): boolean {
  const meta = (error as { meta?: { statusCode?: number; body?: unknown } })?.meta;
  if (meta?.statusCode === 404) return true;
  const body = JSON.stringify(meta?.body ?? error ?? "");
  return body.includes("index_not_found_exception");
}

interface ChunkSource {
  id: string;
  source: string;
  chunk_index: number;
  content: string;
  embedding?: number[];
}

interface DocumentSource {
  source: string;
  title: string;
  tags: string[];
  allowed_groups: string[];
  mime_type: string;
  byte_size: number;
  content_hash: string;
  chunk_count: number;
  version: number;
  chunk_strategy: string;
  chunk_size: number;
  chunk_overlap: number;
  separators: string[];
  semantic_threshold: number | null;
  ocr_applied: boolean;
  ocr_status: string;
  created_at: string;
  updated_at: string;
}

function toDocumentInfo(s: DocumentSource): DocumentInfo {
  const status = s.ocr_status as DocumentInfo["ocrStatus"];
  return {
    source: s.source,
    title: s.title,
    tags: Array.isArray(s.tags) ? s.tags : [],
    allowedGroups: Array.isArray(s.allowed_groups) ? s.allowed_groups : [],
    mimeType: s.mime_type ?? "application/octet-stream",
    byteSize: Number(s.byte_size ?? 0),
    contentHash: s.content_hash ?? "",
    chunks: Number(s.chunk_count ?? 0),
    version: Number(s.version ?? 1),
    chunkStrategy: s.chunk_strategy === "semantic" ? "semantic" : "fixed",
    chunkSize: Number(s.chunk_size ?? 500),
    chunkOverlap: Number(s.chunk_overlap ?? 50),
    separators: Array.isArray(s.separators) ? s.separators : [],
    semanticThreshold: typeof s.semantic_threshold === "number" ? s.semantic_threshold : null,
    ocrApplied: Boolean(s.ocr_applied),
    ocrStatus:
      status === "ocr" ||
      status === "ocr_needed" ||
      status === "ocr_failed" ||
      status === "text_layer"
        ? status
        : "none",
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  };
}

/** 供单测的纯查询构造器：不依赖网络，改 DSL 只改这里。 */
export function buildKeywordQuery(
  query: string,
  sources: readonly string[] | undefined,
  operator: "and" | "or",
): Record<string, unknown> {
  const must = { match: { content: { query, operator: operator === "and" ? "AND" : "OR" } } };
  if (!sources) return { bool: { must } };
  return { bool: { must, filter: [{ terms: { source: [...sources] } }] } };
}

export function buildKnnFilter(
  sources: readonly string[] | undefined,
): Record<string, unknown> | undefined {
  if (!sources) return undefined;
  return { terms: { source: [...sources] } };
}

/**
 * 按 id 批量回取分块的查询构造器（供单测）。
 *
 * 用 terms 查询而不是 mget：mget 无法按 source 过滤，只能取回后再丢，
 * 未授权分块会短暂进入进程内存；terms + filter 在存储层就完成 ACL 收窄。
 */
export function buildChunksByIdsQuery(
  ids: readonly string[],
  sources: readonly string[] | undefined,
): Record<string, unknown> {
  const filter = buildKnnFilter(sources);
  return {
    bool: {
      must: [{ terms: { id: [...ids] } }],
      ...(filter ? { filter: [filter] } : {}),
    },
  };
}

/**
 * Elasticsearch 存储：实现 `VectorStore` 的异步版本。
 * 所有方法均为 `async`，但返回类型兼容 `MaybePromise`，可直接作为 `Rag({ store })` 注入。
 */
export class ElasticsearchVectorStore implements VectorStore {
  private client: Client;
  private owned: boolean;
  private chunksIndex: string;
  private documentsIndex: string;
  private dims: number;
  private refresh: boolean | "wait_for";
  private ensured = false;

  constructor(opts: ElasticsearchStoreOptions = {}) {
    const prefix = opts.indexPrefix ?? "rag";
    const { chunks, documents } = indexNames(prefix);
    this.chunksIndex = chunks;
    this.documentsIndex = documents;
    this.dims = opts.dims ?? DEFAULT_DIMS;
    this.refresh = opts.refresh ?? true;
    if (opts.client) {
      this.client = opts.client;
      this.owned = false;
    } else {
      this.client = new Client({
        node: opts.node ?? "http://localhost:9200",
        ...(opts.clientOptions ?? {}),
      });
      this.owned = true;
    }
  }

  get indices(): { chunks: string; documents: string } {
    return { chunks: this.chunksIndex, documents: this.documentsIndex };
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.ping();
      return true;
    } catch {
      return false;
    }
  }

  /** 建索引（幂等）。`dims` 显式传入时优先，用于首写前预建。 */
  async ensureIndices(dims?: number): Promise<void> {
    const targetDims = dims ?? this.dims;
    const chunksExists = await this.client.indices.exists({ index: this.chunksIndex });
    if (!chunksExists) {
      await this.client.indices.create({
        index: this.chunksIndex,
        mappings: chunksMapping(targetDims) as never,
      });
    }
    const docsExists = await this.client.indices.exists({ index: this.documentsIndex });
    if (!docsExists) {
      await this.client.indices.create({
        index: this.documentsIndex,
        mappings: documentsMapping() as never,
      });
    }
    this.ensured = true;
  }

  /** 测试/重建用：删掉两个索引（维度变更时必须走这里）。 */
  async destroyIndices(): Promise<void> {
    for (const index of [this.chunksIndex, this.documentsIndex]) {
      try {
        await this.client.indices.delete({ index });
      } catch (error) {
        if (!isIndexNotFound(error)) throw error;
      }
    }
    this.ensured = false;
  }

  private async ensure(): Promise<void> {
    if (this.ensured) return;
    await this.ensureIndices();
  }

  async insert(chunk: Chunk, embedding: Float32Array): Promise<void> {
    await this.ensure();
    const doc: ChunkSource = {
      id: chunk.id,
      source: chunk.source,
      chunk_index: chunk.chunkIndex,
      content: chunk.content,
    };
    if (embedding.length > 0) doc.embedding = Array.from(embedding);
    await this.client.index({
      index: this.chunksIndex,
      id: chunk.id,
      document: doc,
      refresh: this.refresh as never,
    });
    await this.touchDocument(chunk.source);
  }

  /**
   * 原子替换的 ES 近似：先删该来源旧分块，再 bulk 写入，最后 upsert 目录。
   * 与 SQLite 不同：三步非事务，bulk 半失败会抛错，调用方重传修复。
   * 目录的 `title/tags/allowedGroups` 会被保留（人工运营数据不被重传覆盖）。
   */
  async replaceSource(
    source: string,
    rows: Array<{ chunk: Chunk; embedding: Float32Array }>,
    metadata: DocumentWriteMetadata,
  ): Promise<void> {
    const firstVector = rows.find((r) => r.embedding.length > 0)?.embedding;
    if (firstVector) this.dims = firstVector.length;
    await this.ensureIndices(this.dims);
    const now = new Date().toISOString();
    const existing = await this.getDocumentSource(source);

    await this.client.deleteByQuery({
      index: this.chunksIndex,
      query: { term: { source } },
      refresh: true,
    });

    if (rows.length > 0) {
      const operations: unknown[] = [];
      for (const { chunk, embedding } of rows) {
        const doc: ChunkSource = {
          id: chunk.id,
          source: chunk.source,
          chunk_index: chunk.chunkIndex,
          content: chunk.content,
        };
        if (embedding.length > 0) doc.embedding = Array.from(embedding);
        operations.push({ index: { _index: this.chunksIndex, _id: chunk.id } }, doc);
      }
      const bulk = await this.client.bulk({ operations: operations as never, refresh: true });
      if (bulk.errors) {
        throw new Error(`elasticsearch bulk index failed for source "${source}"`);
      }
    }

    const next: DocumentSource = {
      source,
      title: existing?.title ?? source,
      tags: existing?.tags ?? [],
      allowed_groups: existing?.allowed_groups ?? [],
      mime_type: metadata.mimeType,
      byte_size: metadata.byteSize,
      content_hash: metadata.contentHash,
      chunk_count: rows.length,
      version: (existing?.version ?? 0) + 1,
      chunk_strategy: metadata.chunkStrategy,
      chunk_size: metadata.chunkSize,
      chunk_overlap: metadata.chunkOverlap,
      separators: [...metadata.separators],
      semantic_threshold: metadata.semanticThreshold,
      ocr_applied: metadata.ocrApplied ?? false,
      ocr_status: metadata.ocrStatus ?? "none",
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    await this.client.index({
      index: this.documentsIndex,
      id: source,
      document: next,
      refresh: this.refresh as never,
    });
  }

  async vectorSearch(
    embedding: number[],
    k: number,
    sources?: readonly string[],
  ): Promise<ScoredChunk[]> {
    if (sources?.length === 0) return [];
    if (embedding.length === 0) return [];
    try {
      const filter = buildKnnFilter(sources);
      const res = await this.client.search<ChunkSource>({
        index: this.chunksIndex,
        knn: {
          field: "embedding",
          query_vector: embedding,
          k,
          num_candidates: Math.max(k * 10, 100),
          ...(filter ? { filter } : {}),
        } as never,
        size: k,
        _source: ["id", "source", "chunk_index", "content"],
      });
      return (res.hits.hits ?? []).map((h) => {
        const s = h._source as unknown as ChunkSource;
        return {
          id: s.id,
          source: s.source,
          chunkIndex: s.chunk_index,
          content: s.content,
          score: typeof h._score === "number" ? h._score : 0,
        } satisfies ScoredChunk;
      });
    } catch (error) {
      if (isIndexNotFound(error)) return [];
      throw error;
    }
  }

  /**
   * BM25 关键词检索：先 AND 精确，0 命中降级 OR（与 SQLite 的 FTS5 策略对齐，
   * 避免“网关启动失败怎么办”这类口语查询全军覆没）。
   */
  async keywordSearch(
    query: string,
    k: number,
    sources?: readonly string[],
  ): Promise<ScoredChunk[]> {
    if (sources?.length === 0) return [];
    if (!query.trim()) return [];
    try {
      const andHits = await this.matchQuery(query, k, sources, "and");
      if (andHits.length > 0) return andHits;
      return this.matchQuery(query, k, sources, "or");
    } catch (error) {
      if (isIndexNotFound(error)) return [];
      throw error;
    }
  }

  private async matchQuery(
    query: string,
    k: number,
    sources: readonly string[] | undefined,
    operator: "and" | "or",
  ): Promise<ScoredChunk[]> {
    const res = await this.client.search<ChunkSource>({
      index: this.chunksIndex,
      query: buildKeywordQuery(query, sources, operator) as never,
      size: k,
      _source: ["id", "source", "chunk_index", "content"],
    });
    return (res.hits.hits ?? []).map((h) => {
      const s = h._source as unknown as ChunkSource;
      return {
        id: s.id,
        source: s.source,
        chunkIndex: s.chunk_index,
        content: s.content,
        score: typeof h._score === "number" ? h._score : 0,
      } satisfies ScoredChunk;
    });
  }

  async removeBySource(source: string): Promise<void> {
    try {
      await this.client.deleteByQuery({
        index: this.chunksIndex,
        query: { term: { source } },
        refresh: true,
      });
    } catch (error) {
      if (!isIndexNotFound(error)) throw error;
    }
    try {
      await this.client.delete({ index: this.documentsIndex, id: source, refresh: true });
    } catch (error) {
      if (!isIndexNotFound(error)) {
        const status = (error as { meta?: { statusCode?: number } })?.meta?.statusCode;
        if (status !== 404) throw error;
      }
    }
  }

  async listSources(): Promise<string[]> {
    try {
      const res = await this.client.search<DocumentSource>({
        index: this.documentsIndex,
        size: MAX_WINDOW,
        _source: ["source"],
        sort: [{ source: "asc" } as never],
      });
      return (res.hits.hits ?? [])
        .map((h) => (h._source as unknown as DocumentSource)?.source)
        .filter((s): s is string => typeof s === "string");
    } catch (error) {
      if (isIndexNotFound(error)) return [];
      throw error;
    }
  }

  async listDocuments(): Promise<DocumentInfo[]> {
    try {
      const res = await this.client.search<DocumentSource>({
        index: this.documentsIndex,
        size: MAX_WINDOW,
        sort: [{ updated_at: "desc" } as never, { source: "asc" } as never],
      });
      return (res.hits.hits ?? []).map((h) =>
        toDocumentInfo(h._source as unknown as DocumentSource),
      );
    } catch (error) {
      if (isIndexNotFound(error)) return [];
      throw error;
    }
  }

  async updateDocument(source: string, patch: DocumentMetadataPatch): Promise<DocumentInfo | null> {
    const existing = await this.getDocumentSource(source);
    if (!existing) return null;
    const next: DocumentSource = {
      ...existing,
      title: patch.title ?? existing.title,
      tags: patch.tags ? [...patch.tags] : existing.tags,
      allowed_groups: patch.allowedGroups ? [...patch.allowedGroups] : existing.allowed_groups,
      updated_at: new Date().toISOString(),
    };
    await this.client.index({
      index: this.documentsIndex,
      id: source,
      document: next,
      refresh: this.refresh as never,
    });
    return toDocumentInfo(next);
  }

  async countChunks(): Promise<number> {
    try {
      const res = await this.client.count({ index: this.chunksIndex });
      return Number(res.count);
    } catch (error) {
      if (isIndexNotFound(error)) return 0;
      throw error;
    }
  }

  async listChunksBySource(source: string): Promise<ChunkInfo[]> {
    try {
      const res = await this.client.search<ChunkSource>({
        index: this.chunksIndex,
        query: { term: { source } } as never,
        size: MAX_WINDOW,
        sort: [{ chunk_index: "asc" } as never],
        _source: ["id", "source", "chunk_index", "content", "embedding"],
      });
      return (res.hits.hits ?? []).map((h) => {
        const s = h._source as unknown as ChunkSource & { embedding?: number[] };
        return {
          id: s.id,
          source: s.source,
          chunkIndex: s.chunk_index,
          content: s.content,
          length: s.content?.length ?? 0,
          hasEmbedding: Array.isArray(s.embedding) && s.embedding.length > 0,
        } satisfies ChunkInfo;
      });
    } catch (error) {
      if (isIndexNotFound(error)) return [];
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.owned) await this.client.close();
  }

  /**
   * 按 id 批量回取真实分块（图谱关系回溯用）。
   * 来源白名单必须在**查询阶段**生效；索引不存在时按空结果降级。
   */
  async getChunksByIds(ids: readonly string[], sources?: readonly string[]): Promise<Chunk[]> {
    if (ids.length === 0 || sources?.length === 0) return [];
    try {
      const res = await this.client.search<ChunkSource>({
        index: this.chunksIndex,
        query: buildChunksByIdsQuery(ids, sources) as never,
        size: ids.length,
        _source: ["id", "source", "chunk_index", "content"],
      });
      return (res.hits.hits ?? []).map((h) => {
        const s = h._source as unknown as ChunkSource;
        return {
          id: s.id,
          source: s.source,
          chunkIndex: s.chunk_index,
          content: s.content,
        } satisfies Chunk;
      });
    } catch (error) {
      if (isIndexNotFound(error)) return [];
      throw error;
    }
  }

  private async getDocumentSource(source: string): Promise<DocumentSource | null> {
    try {
      const res = await this.client.get<DocumentSource>({
        index: this.documentsIndex,
        id: source,
      });
      return (res._source as unknown as DocumentSource) ?? null;
    } catch (error) {
      const status = (error as { meta?: { statusCode?: number } })?.meta?.statusCode;
      if (status === 404 || isIndexNotFound(error)) return null;
      throw error;
    }
  }

  private async touchDocument(source: string): Promise<void> {
    const existing = await this.getDocumentSource(source);
    const now = new Date().toISOString();
    if (existing) {
      const chunks = await this.countChunksForSource(source);
      await this.client.index({
        index: this.documentsIndex,
        id: source,
        document: { ...existing, chunk_count: chunks, updated_at: now },
        refresh: false,
      });
      return;
    }
    const doc: DocumentSource = {
      source,
      title: source,
      tags: [],
      allowed_groups: [],
      mime_type: "application/octet-stream",
      byte_size: 0,
      content_hash: "",
      chunk_count: await this.countChunksForSource(source),
      version: 1,
      chunk_strategy: "fixed",
      chunk_size: 500,
      chunk_overlap: 50,
      separators: [],
      semantic_threshold: null,
      ocr_applied: false,
      ocr_status: "none",
      created_at: now,
      updated_at: now,
    };
    await this.client.index({
      index: this.documentsIndex,
      id: source,
      document: doc,
      refresh: false,
    });
  }

  private async countChunksForSource(source: string): Promise<number> {
    try {
      const res = await this.client.count({
        index: this.chunksIndex,
        query: { term: { source } } as never,
      });
      return Number(res.count);
    } catch (error) {
      if (isIndexNotFound(error)) return 0;
      throw error;
    }
  }
}
