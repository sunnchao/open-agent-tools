import type { Entity, ExtractResult, GraphStore, Subgraph } from "./types.js";
import type { GraphExtractor } from "./extract.js";
import { LlmGraphExtractor, RuleGraphExtractor, type LlmChatFn } from "./extract.js";
import { SqliteGraphStore } from "./store.js";
import { GraphRetriever, type GraphRetrieverOptions } from "./retriever.js";
import { GraphVisualizer } from "./visualize.js";

export type {
  Entity,
  Relation,
  Subgraph,
  GraphQueryResult,
  ExtractResult,
  GraphStore,
  ChunkLike,
} from "./types.js";
export { SqliteGraphStore, type SqliteGraphStoreOptions } from "./store.js";
export {
  LlmGraphExtractor,
  RuleGraphExtractor,
  extractCandidateNames,
  extractJson,
  DEFAULT_ENTITY_TYPES,
  DEFAULT_RELATION_TYPES,
  type GraphExtractor,
  type LlmChatFn,
} from "./extract.js";
export { GraphRetriever, type GraphRetrieverOptions } from "./retriever.js";
export { GraphVisualizer, type GraphExport, type GraphNode, type GraphEdge } from "./visualize.js";
export { sha1, normalizeName, entityId, relationId, serializeSubgraph } from "./utils.js";

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
    this.retriever = new GraphRetriever(this.store);
    this.visualizer = new GraphVisualizer(this.store);
  }

  /** 从分块批量抽取并入库（幂等：同 chunk 来源先清后写由 rag 层保证；此处按实体/关系键 upsert）。 */
  async ingest(chunks: Array<{ id: string; source: string; chunkIndex: number; content: string }>): Promise<{
    files: number;
    entities: number;
    relations: number;
  }> {
    let entityCount = 0;
    let relationCount = 0;
    for (const chunk of chunks) {
      const result = await this.extractor.extract(chunk);
      for (const e of result.entities) this.store.upsertEntity(e);
      for (const r of result.relations) this.store.upsertRelation(r);
      entityCount += result.entities.length;
      relationCount += result.relations.length;
    }
    return { files: chunks.length, entities: entityCount, relations: relationCount };
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

  clearSource(source: string): void {
    this.store.removeBySource(source);
  }

  close(): void {
    this.store.close();
  }
}
