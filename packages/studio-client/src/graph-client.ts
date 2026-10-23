import type {
  GraphExport,
  DocumentGraph,
  GraphRetrieveResult,
  SyncStatus,
  ReconcileResult,
  EntityListResult,
  RelationTypeStat,
} from "@open-agent-tools/api-contracts/graph";
export function createGraphClient(request: <T>(path: string, init?: RequestInit) => Promise<T>) {
  function retrieveGraph(
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
  function documentGraph(source: string): Promise<DocumentGraph> {
    return request(`/graph/documents/${encodeURIComponent(source)}`);
  }
  function neighborsOf(entityId: string, hops = 2, source?: string): Promise<GraphExport> {
    const params = new URLSearchParams({ hops: String(hops) });
    if (source !== undefined) params.set("source", source);
    return request(`/graph/neighbors/${encodeURIComponent(entityId)}?${params.toString()}`);
  }
  function syncStatus(): Promise<SyncStatus> {
    return request("/graph/sync-status");
  }
  function reconcileGraph(): Promise<ReconcileResult> {
    return request("/graph/reconcile", { method: "POST" });
  }
  function listEntities(
    opts: { limit?: number; type?: string; search?: string } = {},
  ): Promise<EntityListResult> {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.type) params.set("type", opts.type);
    if (opts.search) params.set("search", opts.search);
    return request(`/graph/entities?${params.toString()}`);
  }
  function relationTypes(): Promise<{ types: RelationTypeStat[] }> {
    return request("/graph/relations/types");
  }
  return {
    retrieveGraph,
    documentGraph,
    neighborsOf,
    syncStatus,
    reconcileGraph,
    listEntities,
    relationTypes,
  };
}
