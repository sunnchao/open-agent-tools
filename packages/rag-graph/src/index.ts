import type { ChunkLike, Entity, GraphSourceState, GraphStore, Subgraph } from "./types.js";
import type { GraphExtractor } from "./extract.js";
import { LlmGraphExtractor, RuleGraphExtractor, type LlmChatFn } from "./extract.js";
import { SqliteGraphStore } from "./store.js";
import { GraphRetriever, type EmbeddingsLike, type GraphRetrieverOptions } from "./retriever.js";
import { GraphVisualizer } from "./visualize.js";

export type {
  Entity,
  Relation,
  Subgraph,
  GraphQueryResult,
  ExtractResult,
  GraphStore,
  GraphSourceState,
  ChunkLike,
} from "./types.js";
export { SqliteGraphStore, LEGACY_SOURCE, type SqliteGraphStoreOptions } from "./store.js";
export {
  LlmGraphExtractor,
  RuleGraphExtractor,
  extractCandidateNames,
  splitSentences,
  extractJson,
  DEFAULT_ENTITY_TYPES,
  DEFAULT_RELATION_TYPES,
  type GraphExtractor,
  type LlmChatFn,
} from "./extract.js";
export { GraphRetriever, type GraphRetrieverOptions, type EmbeddingsLike } from "./retriever.js";
export { GraphVisualizer, type GraphExport, type GraphNode, type GraphEdge } from "./visualize.js";
export { sha1, normalizeName, entityId, relationId, serializeSubgraph, cosine } from "./utils.js";

export interface KnowledgeGraphOptions {
  /** SQLite 数据库文件路径，默认 ./rag-graph.db。 */
  dbPath?: string;
  /**
   * 抽取器：缺省时按是否提供 llmChat 决定——
   * 提供 llmChat 用 LLM 抽取器，否则用规则抽取器（离线可用）。
   */
  extractor?: GraphExtractor;
  /** LLM 抽取通道：传入后自动装配 LlmGraphExtractor（OpenAI 兼容单次对话）。 */
  llmChat?: LlmChatFn;
  /** 轻量 embeddings：名称匹配为空时对实体名做向量 top-k 兜底。 */
  embeddings?: EmbeddingsLike;
}

/** 知识图谱引擎门面：抽取入库 + 子图检索 + 可视化导出。仿 Rag 类。 */
export class KnowledgeGraph {
  readonly store: GraphStore;
  readonly extractor: GraphExtractor;
  readonly retriever: GraphRetriever;
  readonly visualizer: GraphVisualizer;

  constructor(opts: KnowledgeGraphOptions = {}) {
    this.store = new SqliteGraphStore({ dbPath: opts.dbPath ?? "./rag-graph.db" });
    this.extractor =
      opts.extractor ?? (opts.llmChat ? new LlmGraphExtractor(opts.llmChat) : new RuleGraphExtractor());
    this.retriever = new GraphRetriever(this.store, { embeddings: opts.embeddings });
    this.visualizer = new GraphVisualizer(this.store);
  }

  /**
   * 从分块批量抽取并入库。
   *
   * `replace` 默认开启：同一来源先清空旧图谱再重建，保证「文档重传 = 图谱重建」，
   * 否则改动过的文档会把失效的旧实体关系永久留在图里（只增不清）。
   */
  async ingest(
    chunks: ChunkLike[],
    opts: { replace?: boolean } = {},
  ): Promise<{ files: number; entities: number; relations: number }> {
    const replace = opts.replace ?? true;
    if (replace) {
      for (const source of new Set(chunks.map((c) => c.source))) {
        this.store.removeBySource(source);
      }
    }

    let entityCount = 0;
    let relationCount = 0;
    for (const chunk of chunks) {
      const result = await this.extractor.extract(chunk);
      for (const e of result.entities) {
        this.store.upsertEntity(e);
        // 实体归属到来源：删文档时据此判断实体是否还被其他文档需要
        this.store.linkEntitySource(e.id, chunk.source);
        // 抽取结果 props 中携带的别名（alias / aliases,逗号分隔）注册进别名表,共指合并用
        const aliasField = e.props["alias"] ?? e.props["aliases"] ?? e.props["别名"];
        if (aliasField) {
          for (const alias of aliasField.split(/[,，]/).map((s) => s.trim()).filter(Boolean)) {
            this.store.addAlias(e.id, alias);
          }
        }
      }
      for (const r of result.relations) this.store.upsertRelation(r);
      entityCount += result.entities.length;
      relationCount += result.relations.length;
    }
    return { files: chunks.length, entities: entityCount, relations: relationCount };
  }

  /**
   * 重建单个来源的图谱并登记状态，供生命周期编排调用。
   * 失败时状态置 failed 并抛出，由调用方决定重试或提示。
   */
  async syncSource(source: string, chunks: ChunkLike[]): Promise<GraphSourceState> {
    this.store.markSource(source, { status: "building", chunks: chunks.length });
    try {
      await this.ingest(chunks, { replace: true });
      const counted = this.store.countBySource(source);
      return this.store.markSource(source, {
        status: "ready",
        entities: counted.entities,
        relations: counted.relations,
        chunks: chunks.length,
        error: "",
      });
    } catch (error) {
      this.store.markSource(source, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /** 图谱侧已登记的来源状态列表。 */
  listSources(): GraphSourceState[] {
    return this.store.listSources();
  }

  getSource(source: string): GraphSourceState | null {
    return this.store.getSource(source);
  }

  /**
   * 与知识库来源清单对账。
   * - missing：知识库有、图谱没建（含 pending / failed）
   * - stale：两侧都有但分块数对不上，说明文档被重新切分或重传过
   * - orphan：图谱有、知识库已删（含 v1 遗留占位来源）
   * - building：正在抽取中
   */
  diff(ragSources: Array<{ source: string; chunks: number }>): {
    inSync: boolean;
    missing: string[];
    stale: string[];
    orphan: string[];
    building: string[];
  } {
    const graphStates = new Map(this.store.listSources().map((s) => [s.source, s]));
    const missing: string[] = [];
    const stale: string[] = [];
    const building: string[] = [];

    for (const { source, chunks } of ragSources) {
      const state = graphStates.get(source);
      if (!state || state.status === "pending" || state.status === "failed") {
        missing.push(source);
        continue;
      }
      if (state.status === "building") {
        building.push(source);
        continue;
      }
      if (state.chunks !== chunks) stale.push(source);
    }

    const ragNames = new Set(ragSources.map((s) => s.source));
    const orphan = [...graphStates.keys()].filter((s) => !ragNames.has(s));

    return {
      inSync: missing.length === 0 && stale.length === 0 && orphan.length === 0,
      missing,
      stale,
      orphan,
      building,
    };
  }

  /** 子图检索：种子定位 + 多跳扩展。 */
  retrieve(query: string, opts: GraphRetrieverOptions = {}) {
    return this.retriever.retrieve(query, opts);
  }

  /** 单实体邻域检索。 */
  neighbors(entityId: string, hops = 2): Subgraph {
    return this.store.neighbors(entityId, hops);
  }

  listEntities(opts?: { offset?: number; limit?: number; type?: string; search?: string }): Entity[] {
    return this.store.listEntities(opts);
  }

  getStats(): { entities: number; relations: number } {
    return this.store.stats();
  }

  /** 清除某来源的全部图谱数据与状态登记（知识库删除文档时联动调用）。 */
  clearSource(source: string): { relations: number; entities: number } {
    const removed = this.store.removeBySource(source);
    this.store.removeSourceRecord(source);
    return removed;
  }

  close(): void {
    this.store.close();
  }
}
