import { agentFetch } from "../lib/http";
export interface GraphNode {
  id: string;
  name: string;
  type: string;
}
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
export interface GraphSourceState {
  source: string;
  status: "pending" | "building" | "ready" | "failed";
  entities: number;
  relations: number;
  chunks: number;
  updatedAt: string;
  error?: string;
}
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
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await agentFetch(`/api/admin/rag${path}`, init);
  if (!response.ok)
    throw new Error((await response.text()) || `Graph request failed (${response.status})`);
  return (await response.json()) as T;
}
export function retrieveGraph(query: string, maxHops = 2): Promise<GraphRetrieveResult> {
  return request("/graph/retrieve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, maxHops }),
  });
}
export function neighborsOf(entityId: string, hops = 2): Promise<GraphExport> {
  return request(`/graph/neighbors/${encodeURIComponent(entityId)}?hops=${hops}`);
}
export function listEntities(
  opts: { limit?: number; type?: string; search?: string } = {},
): Promise<EntityListResult> {
  const params = new URLSearchParams();
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.type) params.set("type", opts.type);
  if (opts.search) params.set("search", opts.search);
  return request(`/graph/entities?${params.toString()}`);
}
export function relationTypes(): Promise<{ types: RelationTypeStat[] }> {
  return request("/graph/relations/types");
}
export function syncStatus(): Promise<SyncStatus> {
  return request("/graph/sync-status");
}
export function reconcileGraph(): Promise<ReconcileResult> {
  return request("/graph/reconcile", { method: "POST" });
}
