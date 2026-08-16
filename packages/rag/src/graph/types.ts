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

/** 图谱关系（有向边）。id 为 sha1(src + ":" + relType + ":" + dst)。 */
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

/** 抽取输入：与 packages/rag 的 Chunk 形状兼容的最小接口。 */
export interface ChunkLike {
  id: string;
  source: string;
  chunkIndex: number;
  content: string;
}

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
 * 存储后端接口：换 Neo4j / 内存图时新增实现，调用方 API 不变。
 * 仿 packages/rag 的 VectorStore 插拔模式。
 */
export interface GraphStore {
  upsertEntity(e: Entity): void;
  upsertRelation(r: Relation): void;
  findEntityById(id: string): Entity | null;
  /** 名称匹配：精确优先，其次包含；规范化后比较。 */
  findEntitiesByName(name: string, limit?: number): Entity[];
  /** BFS 多跳邻域扩展；hop=1 时只返回直接邻居。 */
  neighbors(
    entityId: string,
    hops: number,
    opts?: { maxNodes?: number; minWeight?: number },
  ): Subgraph;
  /**
   * 级联删除某来源：删该来源的关系 → 解绑实体来源 → 删除不再被任何来源引用的实体及其别名。
   * 被多个来源共享的实体只解绑，不删除。
   */
  removeBySource(source: string): { relations: number; entities: number };
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
  /** 统计某来源实际关联的实体数与关系数（对账校验用）。 */
  countBySource(source: string): { entities: number; relations: number };
  listEntities(opts?: { offset?: number; limit?: number; type?: string; search?: string }): Entity[];
  stats(): { entities: number; relations: number };
  /** 关系类型分布统计（可视化图例用）。 */
  countRelationsByType(): { relType: string; count: number }[];
  /** 为实体注册别名（共指合并用），别名规范化后存储。 */
  addAlias(entityId: string, alias: string): void;
  /** 通过别名定位实体（规范化匹配）。 */
  findByAlias(alias: string): Entity | null;
  /** 列出实体的全部别名。 */
  aliasesOf(entityId: string): string[];
  close(): void;
}
