/** 图谱节点（与后端 GraphExport.GraphNode 对齐）。 */
export interface GraphNode {
  id: string;
  name: string;
  type: string;
}

/** 图谱边（与后端 GraphExport.GraphEdge 对齐）。 */
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relType: string;
  weight: number;
}

export interface GraphExport {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: { entities: number; relations: number };
}

export interface EntityInfo extends GraphNode {
  props: Record<string, string>;
}

export interface GraphRetrieveResult {
  query: string;
  seeds: Array<{ id: string; name: string; type: string }>;
  formatted: string;
  subgraph: GraphExport | null;
}

export interface EntityListResult {
  entities: EntityInfo[];
  stats: { entities: number; relations: number };
}

export interface RelationTypeStat {
  relType: string;
  count: number;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/rag-api${path}`, init);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Graph request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

/** 子图检索：种子定位 + 多跳扩展。 */
export function retrieveGraph(query: string, maxHops = 2): Promise<GraphRetrieveResult> {
  return request("/graph/retrieve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, maxHops }),
  });
}

/** 单实体 2 跳邻居子图（点击节点动态展开）。 */
export function neighborsOf(entityId: string, hops = 2): Promise<GraphExport> {
  return request(`/graph/neighbors/${encodeURIComponent(entityId)}?hops=${hops}`);
}

/** 实体列表（分页 + 类型 + 搜索）。 */
export function listEntities(opts: {
  limit?: number;
  type?: string;
  search?: string;
} = {}): Promise<EntityListResult> {
  const params = new URLSearchParams();
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.type) params.set("type", opts.type);
  if (opts.search) params.set("search", opts.search);
  return request(`/graph/entities?${params.toString()}`);
}

/** 关系类型分布（图例）。 */
export function relationTypes(): Promise<{ types: RelationTypeStat[] }> {
  return request("/graph/relations/types");
}

/** 单个文档来源的建图状态。 */
export interface GraphSourceState {
  source: string;
  status: "pending" | "building" | "ready" | "failed";
  entities: number;
  relations: number;
  chunks: number;
  updatedAt: string;
  error?: string;
}

/** 知识库与图谱库的一致性快照。 */
export interface SyncStatus {
  inSync: boolean;
  missing: string[];
  stale: string[];
  orphan: string[];
  building: string[];
  queued: number;
  sources: GraphSourceState[];
  ragSources: Array<{ source: string; chunks: number }>;
  stats: { entities: number; relations: number };
}

export interface ReconcileResult {
  rebuilt: string[];
  removed: string[];
  failed: Array<{ source: string; error: string }>;
  status: SyncStatus;
}

/** 查询知识库与图谱库是否同步。 */
export function syncStatus(): Promise<SyncStatus> {
  return request("/graph/sync-status");
}

/** 一键对账：重建缺失/过期来源，清理孤儿来源。 */
export function reconcileGraph(): Promise<ReconcileResult> {
  return request("/graph/reconcile", { method: "POST" });
}
