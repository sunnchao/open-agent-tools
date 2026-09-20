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

export interface ObservatoryColumn {
  name: string;
  type: string;
  comment: string;
}

export interface ObservatoryTable {
  name: string;
  comment: string;
  rows: number;
  columnCount: number;
  columns: ObservatoryColumn[];
}

export interface ObservatoryGraphPayload {
  source: SchemaSourceOption;
  database: string;
  collectedAt: string;
  tables: ObservatoryTable[];
  graph: GraphExport;
  stats: { entities: number; relations: number };
}

export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ObservatoryQueryResult {
  sourceId: string;
  question: string;
  intent?: string;
  selectedTables: string[];
  schemaPrompt: string;
  graph: GraphExport;
  seeds: string[];
  formattedGraph: string;
  sql?: string;
  clarifying?: string;
  rows?: Record<string, unknown>[];
  error?: string;
  durationMs: number;
}

export type SchemaSemanticProfile = "generic" | "oneapi";
export type SchemaSourceConnector = "mysql" | "postgresql";
export type SchemaSourceSyncStatus = "idle" | "syncing" | "ready" | "error";

export interface SchemaSourceOption {
  id: string;
  name: string;
  connector: SchemaSourceConnector;
  databaseName: string | null;
  schemaName: string | null;
  semanticProfile: SchemaSemanticProfile;
  isDefault: boolean;
  managedByEnv: boolean;
  syncStatus: SchemaSourceSyncStatus;
  lastSyncedAt: string | null;
  tableCount: number;
  relationCount: number;
}

export interface SchemaSourceMetadata extends SchemaSourceOption {
  endpoint: string;
  tableFilter: string[];
  enabled: boolean;
  hasCredential: boolean;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SchemaCatalogPreview {
  sourceId: string;
  database: string;
  collectedAt: string;
  relationCount: number;
  tables: Array<{
    name: string;
    comment: string;
    rows: number;
    columnCount: number;
  }>;
}

export interface SchemaSourceDraft {
  id?: string;
  name: string;
  connector: SchemaSourceConnector;
  connectionString?: string;
  databaseName: string;
  schemaName: string;
  tableFilter: string[];
  semanticProfile: SchemaSemanticProfile;
  enabled: boolean;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function fetchSchemaSources(): Promise<SchemaSourceOption[]> {
  return request<{ sources: SchemaSourceOption[] }>("/api/schema-sources").then(
    (body) => body.sources,
  );
}

export function fetchAdminSchemaSources(): Promise<SchemaSourceMetadata[]> {
  return request<{ sources: SchemaSourceMetadata[] }>("/api/admin/schema-sources").then(
    (body) => body.sources,
  );
}

export function saveSchemaSource(input: SchemaSourceDraft): Promise<SchemaSourceMetadata> {
  return request<{ source: SchemaSourceMetadata }>(
    input.id
      ? `/api/admin/schema-sources/${encodeURIComponent(input.id)}`
      : "/api/admin/schema-sources",
    {
      method: input.id ? "PUT" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  ).then((body) => body.source);
}

export function removeSchemaSource(id: string): Promise<void> {
  return request<void>(`/api/admin/schema-sources/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function setDefaultSchemaSource(id: string): Promise<SchemaSourceMetadata> {
  return request<{ source: SchemaSourceMetadata }>(
    `/api/admin/schema-sources/${encodeURIComponent(id)}/default`,
    { method: "PUT" },
  ).then((body) => body.source);
}

export function duplicateSchemaSource(id: string): Promise<SchemaSourceMetadata> {
  return request<{ source: SchemaSourceMetadata }>(
    `/api/admin/schema-sources/${encodeURIComponent(id)}/duplicate`,
    { method: "POST" },
  ).then((body) => body.source);
}

export function syncSchemaSource(id: string): Promise<SchemaSourceMetadata> {
  return request<{ source: SchemaSourceMetadata }>(
    `/api/admin/schema-sources/${encodeURIComponent(id)}/sync`,
    { method: "POST" },
  ).then((body) => body.source);
}

export function fetchSchemaCatalog(id: string): Promise<SchemaCatalogPreview> {
  return request(`/api/admin/schema-sources/${encodeURIComponent(id)}/catalog`);
}

export function testSchemaSource(input: {
  id?: string;
  connector?: SchemaSourceConnector;
  connectionString?: string;
  databaseName?: string;
  schemaName?: string;
}): Promise<{ ok: true; database: string; version: string }> {
  return request(
    input.id
      ? `/api/admin/schema-sources/${encodeURIComponent(input.id)}/test`
      : "/api/admin/schema-sources/test",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}

export function fetchObservatoryGraph(sourceId: string): Promise<ObservatoryGraphPayload> {
  return request(`/api/observatory/graph?sourceId=${encodeURIComponent(sourceId)}`);
}

export function rebuildObservatoryGraph(sourceId: string): Promise<{
  ok: boolean;
  sourceId: string;
  stats: { entities: number; relations: number };
  graph: GraphExport;
}> {
  return request("/api/observatory/rebuild", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceId }),
  });
}

export function runObservatoryQuery(
  sourceId: string,
  question: string,
  history: HistoryTurn[] = [],
): Promise<ObservatoryQueryResult> {
  return request("/api/observatory/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceId, question, history }),
  });
}

export function neighborsOf(edges: GraphEdge[], name: string, nodes: GraphNode[]): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node.name]));
  const out: string[] = [];
  for (const edge of edges) {
    const src = byId.get(edge.source);
    const dst = byId.get(edge.target);
    if (src === name && dst) out.push(dst);
    if (dst === name && src) out.push(src);
  }
  return [...new Set(out)];
}

export function walkChain(
  edges: GraphEdge[],
  nodes: GraphNode[],
  startNames: string[],
  hops: number,
): Set<string> {
  const seen = new Set(startNames);
  let frontier = [...startNames];
  for (let hop = 0; hop < hops; hop += 1) {
    const next: string[] = [];
    for (const name of frontier) {
      for (const neighbor of neighborsOf(edges, name, nodes)) {
        if (!seen.has(neighbor)) {
          seen.add(neighbor);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

export function edgeIdsInSet(
  edges: GraphEdge[],
  nodes: GraphNode[],
  names: Set<string>,
): Set<string> {
  const byId = new Map(nodes.map((node) => [node.id, node.name]));
  const ids = new Set<string>();
  for (const edge of edges) {
    const src = byId.get(edge.source);
    const dst = byId.get(edge.target);
    if (src && dst && names.has(src) && names.has(dst)) ids.add(edge.id);
  }
  return ids;
}
