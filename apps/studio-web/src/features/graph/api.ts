import { ragRequest as request } from "../../lib/client.js";
import type { MessageUsage } from "../../types.js";

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

export interface DocumentGraph extends GraphExport {
  nodes: EntityInfo[];
}

export interface EntityInfo extends GraphNode {
  props: Record<string, string>;
}

export interface GraphRetrieveResult {
  usage?: MessageUsage;
  query: string;
  seeds: Array<{ id: string; name: string; type: string }>;
  formatted: string;
  subgraph: GraphExport | null;
}

/** 子图检索：种子定位 + 多跳扩展。 */
export function retrieveGraph(
  query: string,
  maxHops = 2,
  sources?: string[],
): Promise<GraphRetrieveResult> {
  return request("/graph/retrieve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, maxHops, ...(sources !== undefined ? { sources } : {}) }),
  });
}

export function documentGraph(source: string): Promise<DocumentGraph> {
  return request(`/graph/documents/${encodeURIComponent(source)}`);
}

/** 单实体 2 跳邻居子图（点击节点动态展开）。 */
export function neighborsOf(entityId: string, hops = 2, source?: string): Promise<GraphExport> {
  const params = new URLSearchParams({ hops: String(hops) });
  if (source !== undefined) params.set("source", source);
  return request(`/graph/neighbors/${encodeURIComponent(entityId)}?${params.toString()}`);
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
  usage?: MessageUsage;
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
  usage?: MessageUsage;
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
