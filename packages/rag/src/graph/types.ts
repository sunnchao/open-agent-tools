/**
 * 关系来源通道。用于区分「语义谓词」与「句内共现」两类边：
 * 共现边（rule）在检索排序里被降权，避免噪声边挤占图谱通道候选。
 */
export type RelationOrigin = "llm" | "rule" | "schema";

/** 知识图谱实体。id 为稳定键 sha1(normalizeName(name) + ":" + type)。 */
export interface Entity {
  id: string;
  /** 规范化名称（trim、全半角归一、小写折叠）。 */
  name: string;
  /** person | org | product | tech | place | concept ... */
  type: string;
  /** 抽取到的属性（可选）。 */
  props: Record<string, string>;
}

/** 图谱关系（有向边）。id 为 sha1(src + ":" + relType + ":" + dst)；对称谓词按端点排序后取值。 */
export interface Relation {
  id: string;
  srcId: string;
  dstId: string;
  relType: string;
  /** 同源三元组出现频次，子图扩展截断与去重用。 */
  weight: number;
  /** 来源分块 id，回溯引用。 */
  sourceChunk: string;
  /**
   * 文档来源名（与 rag 的 chunk.source 同值），生命周期级联删除的锚点。
   * 历史数据可能为空串，reconcile 时会被重建。
   */
  source: string;
  /**
   * 抽取通道。历史数据缺省为空，读取时按 "llm" 处理以保持旧行为。
   * `rule` 表示句内共现建边（谓词恒为 related_to），排序时按谓词特异性降权。
   */
  origin?: RelationOrigin;
}

/** 子图：种子实体邻域内的实体与关系集合。 */
export interface Subgraph {
  entities: Entity[];
  relations: Relation[];
  /** 序列化为可拼 prompt 的文本（三元组 + 来源引用）。 */
  formatted(): string;
}

export interface GraphQueryResult {
  query: string;
  /** 命中子图；种子未命中时为 null。 */
  subgraph: Subgraph | null;
  /** 命中的种子实体（可能为空）。 */
  seeds: Entity[];
}

/** 单次抽取结果。 */
export interface ExtractResult {
  entities: Entity[];
  relations: Relation[];
}

/** 图谱抽取直接使用知识库分块，保留原类型导出名。 */
export type { Chunk as ChunkLike } from "../types.js";

/** 单个文档来源的建图状态（图谱库与知识库对账依据）。 */
export interface GraphSourceState {
  /** 文档来源名，与 rag 的 chunk.source 同值。 */
  source: string;
  /** pending 已登记待建 / building 抽取中 / ready 已就绪 / failed 抽取失败。 */
  status: "pending" | "building" | "ready" | "failed";
  /** 该来源贡献的实体数（去重后绑定数）。 */
  entities: number;
  /** 该来源贡献的关系数。 */
  relations: number;
  /** 建图时消费的分块数，用于判断知识库是否已变更（stale 检测）。 */
  chunks: number;
  /** 最近一次状态变更时间（ISO 字符串）。 */
  updatedAt: string;
  /** 失败原因（status=failed 时有值）。 */
  error?: string;
}

/**
 * 图谱质量快照（一次 SQL 聚合得出）。
 *
 * 判定「图谱有没有被建坏」靠这几个硬指标：共现边占比过高说明谓词抽取没生效；
 * weight=1 占比过高说明跨文档证据没有累加；叶子/孤立实体过多说明扩展无收益；
 * 同名多 type 组数说明实体身份被切碎。
 */
export interface GraphQuality {
  entities: number;
  relations: number;
  /** 度为 0 的实体（存了但检索永远走不到）。 */
  isolatedEntities: number;
  /** 度 <= 1 的实体（无法作为多跳中间节点）。 */
  leafEntities: number;
  /** 句内共现建边占全部关系的比例（0-1）。 */
  relatedToRatio: number;
  /** 出现次数恰为 1 的关系占比（0-1），反映跨文档证据聚合是否生效。 */
  weightOneRatio: number;
  /** 平均度。 */
  avgDegree: number;
  /** 同名多 type 的实体组数（应被消解）。 */
  duplicateNameGroups: number;
  /** 消解后可去掉的冗余实体行数。 */
  redundantEntities: number;
  /** 同谓词反向重复边对数（对称谓词归一后可消除）。 */
  reverseDuplicateRelations: number;
  /** 自环边数量。 */
  selfLoops: number;
  /** 关系类型分布。 */
  relationsByType: { relType: string; count: number }[];
}

/** 实体消解的结果统计。 */
export interface DuplicateResolution {
  /** 被合并的实体组数。 */
  groups: number;
  /** 被删除的冗余实体行数。 */
  removedEntities: number;
  /** 被重定向到主实体的关系数。 */
  movedRelations: number;
  /** 因重定向后语义重复而被丢弃的关系数。 */
  droppedRelations: number;
}

/**
 * 存储后端接口：换 Neo4j / 内存图时新增实现，调用方 API 不变。
 * 仿 packages/rag 的 VectorStore 插拔模式。
 */
export interface GraphStore {
  upsertEntity(e: Entity): void;
  upsertRelation(r: Relation): void;
  findEntityById(id: string): Entity | null;
  /** 名称匹配：精确优先，其次包含；规范化后比较。 */
  findEntitiesByName(name: string, limit?: number): Entity[];
  /** 限定来源名称匹配：只返回至少被这些来源之一引用的实体。 */
  findEntitiesByNameInSources?(name: string, sources: readonly string[], limit?: number): Entity[];
  /** BFS 多跳邻域扩展；hop=1 时只返回直接邻居。 */
  neighbors(
    entityId: string,
    hops: number,
    opts?: { maxNodes?: number; minWeight?: number; sources?: readonly string[] },
  ): Subgraph;
  /**
   * 批量多跳邻域扩展：一次查询取回多个起点的邻域，替代逐个节点调用 neighbors。
   * 未实现时调用方回退到逐个 neighbors。
   */
  neighborsBatch?(
    entityIds: readonly string[],
    hops: number,
    opts?: { maxNodes?: number; minWeight?: number; sources?: readonly string[] },
  ): Subgraph;
  /** 批量按 id 取实体，避免逐条查询。 */
  findEntitiesByIds?(ids: readonly string[]): Entity[];
  /** 某文档贡献的完整图谱，包含孤立实体，不做邻域或数量截断。 */
  graphForSource(source: string): Subgraph;
  /**
   * 级联删除某来源：删该来源的关系 → 解绑实体来源 → 删除不再被任何来源引用的实体及其别名。
   * 被多个来源共享的实体只解绑，不删除。
   */
  removeBySource(source: string): { relations: number; entities: number };
  /** 仅当关系已无任何来源支撑时删除；被其他来源佐证时只解绑，返回是否真删。 */
  removeRelationIfUnreferenced?(relationId: string, source: string): boolean;
  /** 仅当实体无来源归属且无边连接时删除，返回是否真删。 */
  removeEntityIfUnreferenced?(entityId: string, source: string): boolean;
  /** 将实体绑定到文档来源（多对多，重复绑定幂等）。 */
  linkEntitySource(entityId: string, source: string): void;
  /** 图谱侧已登记的全部来源状态（对账用）。 */
  listSources(): GraphSourceState[];
  /** 读取单个来源状态，未登记返回 null。 */
  getSource(source: string): GraphSourceState | null;
  /** 写入来源状态（登记或更新，字段级合并）。 */
  markSource(
    source: string,
    patch: Partial<Omit<GraphSourceState, "source" | "updatedAt">>,
  ): GraphSourceState;
  /** 移除来源登记记录（仅状态行，不动图数据）。 */
  removeSourceRecord(source: string): void;
  /**
   * 把卡在 building 且超过阈值的来源降级为 pending（进程重启/崩溃后自愈）。
   * 返回被重置的来源名。
   */
  resetStuckSources?(updatedBefore: string): string[];
  /** 统计某来源实际关联的实体数与关系数（对账校验用）。 */
  countBySource(source: string): { entities: number; relations: number };
  listEntities(opts?: {
    offset?: number;
    limit?: number;
    type?: string;
    search?: string;
  }): Entity[];
  stats(): { entities: number; relations: number };
  /** 关系类型分布统计（可视化图例用）。 */
  countRelationsByType(): { relType: string; count: number }[];
  /** 图谱质量快照（共现边占比、度分布、重复实体等）。 */
  quality?(): GraphQuality;
  /**
   * 合并同名实体：把 duplicate 的边与归属全部重定向到 primary 后删除 duplicate。
   * 用于消解「同一名称被抽成多个 type」造成的图碎片化。
   */
  mergeEntities?(
    primaryId: string,
    duplicateIds: readonly string[],
  ): {
    movedRelations: number;
    droppedRelations: number;
    removedEntities: number;
  };
  /** 为实体注册别名（共指合并用），别名规范化后存储。 */
  addAlias(entityId: string, alias: string): void;
  /** 通过别名定位实体（规范化匹配）。 */
  findByAlias(alias: string): Entity | null;
  /** 限定来源的别名定位。 */
  findByAliasInSources?(alias: string, sources: readonly string[]): Entity | null;
  /** 列出支撑某实体的全部文档来源（来源过滤用）。 */
  entitySources?(entityId: string): string[];
  /** 批量取得来源白名单支撑的实体 ID，避免向量候选逐条读取来源。 */
  entityIdsInSources?(sources: readonly string[]): string[];
  /** 列出实体的全部别名。 */
  aliasesOf(entityId: string): string[];
  /** 写入实体名向量（入库时预计算，避免检索期反复调用 embedding）。 */
  upsertEntityEmbeddings?(entries: ReadonlyArray<{ id: string; vector: readonly number[] }>): void;
  /** 读取全部实体名向量（向量兜底种子定位用）。 */
  listEntityEmbeddings?(): Array<{ id: string; vector: number[] }>;
  /** 实体集合或向量发生变化时递增；未实现时检索器每次重新读取。 */
  entityVectorRevision?(): number;
  close(): void;
}
