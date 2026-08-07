import type { Entity, GraphStore, Relation, Subgraph } from "./types.js";

/** 前端力导向图节点。 */
export interface GraphNode {
  id: string;
  name: string;
  type: string;
}

/** 前端力导向图边。 */
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relType: string;
  weight: number;
}

/** 可直供前端渲染的子图导出格式。 */
export interface GraphExport {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: { entities: number; relations: number };
}

export class GraphVisualizer {
  private store: GraphStore;

  constructor(store: GraphStore) {
    this.store = store;
  }

  /** 子图导出（前端力导向图数据源）。 */
  exportSubgraph(subgraph: Subgraph): GraphExport {
    const nodes = subgraph.entities.map((e) => ({
      id: e.id,
      name: e.name,
      type: e.type,
    }));
    const edges = subgraph.relations.map((r) => ({
      id: r.id,
      source: r.srcId,
      target: r.dstId,
      relType: r.relType,
      weight: r.weight,
    }));
    return { nodes, edges, stats: { entities: nodes.length, relations: edges.length } };
  }

  /** 单实体 1-2 跳邻居子图导出（面板点击展开用）。 */
  exportNeighbors(entityId: string, hops = 2): GraphExport {
    const sub = this.store.neighbors(entityId, hops);
    return this.exportSubgraph(sub);
  }

  /** 全量实体列表（分页 + 类型过滤 + 名称搜索），面板浏览用。 */
  listEntities(opts: { offset?: number; limit?: number; type?: string; search?: string } = {}): {
    entities: Entity[];
    stats: { entities: number; relations: number };
  } {
    return { entities: this.store.listEntities(opts), stats: this.store.stats() };
  }

  /** 关系类型分布（面板筛选/图例用）。 */
  relationTypes(): { relType: string; count: number }[] {
    return this.store.countRelationsByType();
  }
}
