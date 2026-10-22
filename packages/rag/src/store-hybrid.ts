/**
 * 「向量 + 关键词」异构双写存储。
 *
 * 用途：向量召回交给 PostgreSQL + pgvector（`PgVectorStore`），BM25 关键词召回交给
 * Elasticsearch（`ElasticsearchVectorStore`），两者共用同一份 `VectorStore` 接口，
 * `retriever.ts` 的三路 RRF 融合逻辑完全不用改。
 *
 * 职责划分（重要）：
 * - **PostgreSQL 是唯一 Source of Truth**：目录（`listDocuments` / `updateDocument`）、
 *   分块明细（`listChunksBySource` / `getChunksByIds`）、计数都以 PG 为准；
 * - **Elasticsearch 是派生的关键词索引**：只同步 `content` 等文本字段，不要求存向量。
 *   它可以随时用 `resync()` 从 PG 全量重建，因此不存在「两边都改了导致对不上」的问题。
 *
 * 同步失败的策略：
 * - `lenient`（默认）：PG 写成功后 ES 失败只 `console.warn`，不阻断入库。
 *   代价是关键词通道暂时缺该来源，需调用 `resync()` 或重传修复；
 * - `strict`：ES 失败即抛错，入库整体失败（调用方会看到半写状态）。
 * 无论哪种，PG 侧都不会因 ES 故障丢数据——这是选 PG 做主存的核心理由。
 */
import type {
  Chunk,
  ChunkInfo,
  DocumentInfo,
  DocumentMetadataPatch,
  DocumentWriteMetadata,
  ScoredChunk,
  VectorStore,
} from "./types.js";

export interface HybridVectorStoreOptions {
  /** 主存储：向量 + 目录（通常是 `PgVectorStore`）。 */
  vectorStore: VectorStore;
  /** 关键词存储：BM25（通常是 `ElasticsearchVectorStore`）。 */
  keywordStore: VectorStore;
  /** 关键词侧写入同步失败时的行为，默认 `lenient`（只告警）。 */
  syncMode?: "lenient" | "strict";
  /**
   * 关键词侧**查询**失败时的行为，默认 `degrade`。
   *
   * 关键词通道是辅助召回：ES 临时不可用时降级为空候选，向量通道照常返回结果，
   * 总比整个检索 500 好。`strict` 则把异常抛给调用方（用于强一致场景）。
   */
  keywordFailureMode?: "degrade" | "strict";
  /** 自定义日志（默认 `console.warn`）；便于服务层接入结构化日志。 */
  logger?: (message: string, error?: unknown) => void;
}

/** 从目录信息还原 `DocumentWriteMetadata`，供 `resync` 重建关键词索引。 */
function metadataOf(document: DocumentInfo): DocumentWriteMetadata {
  return {
    mimeType: document.mimeType,
    byteSize: document.byteSize,
    contentHash: document.contentHash,
    chunkStrategy: document.chunkStrategy,
    chunkSize: document.chunkSize,
    chunkOverlap: document.chunkOverlap,
    separators: [...document.separators],
    semanticThreshold: document.semanticThreshold,
    ocrApplied: document.ocrApplied,
    ocrStatus: document.ocrStatus,
  };
}

export class HybridVectorStore implements VectorStore {
  private vectorStore: VectorStore;
  private keywordStore: VectorStore;
  private syncMode: "lenient" | "strict";
  private keywordFailureMode: "degrade" | "strict";
  private logger: (message: string, error?: unknown) => void;

  constructor(opts: HybridVectorStoreOptions) {
    this.vectorStore = opts.vectorStore;
    this.keywordStore = opts.keywordStore;
    this.syncMode = opts.syncMode ?? "lenient";
    this.keywordFailureMode = opts.keywordFailureMode ?? "degrade";
    this.logger =
      opts.logger ??
      ((message, error) => {
        console.warn(`[rag] ${message}`, error instanceof Error ? error.message : (error ?? ""));
      });
  }

  /** 暴露两个底层存储，便于健康检查与运维脚本单独探测。 */
  get stores(): { vector: VectorStore; keyword: VectorStore } {
    return { vector: this.vectorStore, keyword: this.keywordStore };
  }

  /** 关键词侧同步：lenient 只告警，strict 抛错。 */
  private async syncKeyword(action: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      if (this.syncMode === "strict") throw error;
      this.logger(`keyword store sync failed during ${action}`, error);
    }
  }

  async insert(chunk: Chunk, embedding: Float32Array): Promise<void> {
    await this.vectorStore.insert(chunk, embedding);
    // 关键词索引只要文本，向量置空避免 ES 侧再存一份 dense_vector。
    await this.syncKeyword(`insert(${chunk.source})`, () =>
      Promise.resolve(this.keywordStore.insert(chunk, new Float32Array(0))),
    );
  }

  async replaceSource(
    source: string,
    rows: Array<{ chunk: Chunk; embedding: Float32Array }>,
    metadata: DocumentWriteMetadata,
  ): Promise<void> {
    await this.vectorStore.replaceSource(source, rows, metadata);
    await this.syncKeyword(`replaceSource(${source})`, () =>
      Promise.resolve(
        this.keywordStore.replaceSource(
          source,
          rows.map(({ chunk }) => ({ chunk, embedding: new Float32Array(0) })),
          metadata,
        ),
      ),
    );
  }

  /** 向量召回走 PG。 */
  async vectorSearch(
    embedding: number[],
    k: number,
    sources?: readonly string[],
  ): Promise<ScoredChunk[]> {
    return this.vectorStore.vectorSearch(embedding, k, sources);
  }

  /** 关键词召回走 ES（BM25）；失败默认降级为空候选，不拖垮向量通道。 */
  async keywordSearch(
    query: string,
    k: number,
    sources?: readonly string[],
  ): Promise<ScoredChunk[]> {
    try {
      return await this.keywordStore.keywordSearch(query, k, sources);
    } catch (error) {
      if (this.keywordFailureMode === "strict") throw error;
      this.logger("keyword search failed, degrading to vector-only retrieval", error);
      return [];
    }
  }

  async removeBySource(source: string): Promise<void> {
    await this.vectorStore.removeBySource(source);
    await this.syncKeyword(`removeBySource(${source})`, () =>
      Promise.resolve(this.keywordStore.removeBySource(source)),
    );
  }

  async listSources(): Promise<string[]> {
    return this.vectorStore.listSources();
  }

  async listDocuments(): Promise<DocumentInfo[]> {
    return this.vectorStore.listDocuments();
  }

  async updateDocument(source: string, patch: DocumentMetadataPatch): Promise<DocumentInfo | null> {
    const updated = await this.vectorStore.updateDocument(source, patch);
    if (!updated) return null;
    // 关键词索引里的文档目录也同步一份，保证两边的 title/tags/ACL 展示一致。
    if (this.keywordStore.listChunksBySource) {
      await this.syncKeyword(`updateDocument(${source})`, async () => {
        const chunks = await this.vectorStore.listChunksBySource?.(source);
        await this.keywordStore.replaceSource(
          source,
          (chunks ?? []).map((chunk) => ({
            chunk: {
              id: chunk.id,
              source: chunk.source,
              chunkIndex: chunk.chunkIndex,
              content: chunk.content,
            },
            embedding: new Float32Array(0),
          })),
          metadataOf(updated),
        );
      });
    }
    return updated;
  }

  async countChunks(): Promise<number> {
    return this.vectorStore.countChunks();
  }

  async listChunksBySource(source: string): Promise<ChunkInfo[]> {
    if (!this.vectorStore.listChunksBySource) return [];
    return this.vectorStore.listChunksBySource(source);
  }

  async getChunksByIds(ids: readonly string[], sources?: readonly string[]): Promise<Chunk[]> {
    if (!this.vectorStore.getChunksByIds) return [];
    return this.vectorStore.getChunksByIds(ids, sources);
  }

  /**
   * 从主存储（PG）全量或按来源重建关键词索引（ES）。
   *
   * 适用场景：ES 数据卷被清空、索引 mapping 变更后重建、`lenient` 模式下出现过同步失败。
   * 返回实际重建的来源数与分块数，便于运维确认。
   */
  async resync(sources?: readonly string[]): Promise<{ sources: number; chunks: number }> {
    const targets = sources?.length
      ? [...new Set(sources)]
      : await this.vectorStore.listSources();
    let chunkTotal = 0;
    for (const source of targets) {
      const chunks = (await this.vectorStore.listChunksBySource?.(source)) ?? [];
      if (chunks.length === 0) continue;
      const documents = await this.vectorStore.listDocuments();
      const document = documents.find((item) => item.source === source);
      if (!document) continue;
      await this.keywordStore.replaceSource(
        source,
        chunks.map((chunk) => ({
          chunk: {
            id: chunk.id,
            source: chunk.source,
            chunkIndex: chunk.chunkIndex,
            content: chunk.content,
          },
          embedding: new Float32Array(0),
        })),
        metadataOf(document),
      );
      chunkTotal += chunks.length;
    }
    return { sources: targets.length, chunks: chunkTotal };
  }

  async close(): Promise<void> {
    await this.vectorStore.close?.();
    await this.keywordStore.close?.();
  }
}
