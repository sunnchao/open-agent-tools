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
  /** 删除某来源关联的全部关系与实体（级联）。 */
  removeBySource(source: string): void;
  listEntities(opts?: { offset?: number; limit?: number; type?: string; search?: string }): Entity[];
  stats(): { entities: number; relations: number };
  /** 关系类型分布统计（可视化图例用）。 */
  countRelationsByType(): { relType: string; count: number }[];
  close(): void;
}
