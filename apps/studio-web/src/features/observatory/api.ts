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
  auditId?: string;
  steps?: QueryStep[];
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
  truncated?: boolean;
  error?: string;
  durationMs: number;
}

export type QueryAuditStatus = "running" | "succeeded" | "failed" | "clarifying";
export interface QueryStep {
  id: string;
  label: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  message?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
}

export const QUERY_STEP_LABELS = [
  ["source", "解析数据源"],
  ["schema", "加载 Schema"],
  ["retrieval", "检索相关表"],
  ["generation", "生成 SQL"],
  ["validation", "校验 SQL"],
  ["execution", "执行查询"],
  ["output", "输出结果"],
] as const;

export function pendingQuerySteps(): QueryStep[] {
  return QUERY_STEP_LABELS.map(([id, label]) => ({ id, label, status: "pending" }));
}

export interface QueryAuditSummary {
  id: string;
  sourceId: string | null;
  sourceName: string | null;
  question: string;
  status: QueryAuditStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number;
  rowCount: number | null;
  error: string | null;
}

export interface QueryAuditRecord extends QueryAuditSummary {
  history: HistoryTurn[];
  steps: QueryStep[];
  selectedTables: string[];
  sql: string | null;
  clarifying: string | null;
  providerId: string | null;
  model: string | null;
  resultPreview: Record<string, unknown>[];
}

export type QueryProgressEvent =
  | { type: "start"; auditId: string; steps: QueryStep[] }
  | { type: "step"; auditId: string; step: QueryStep };

export function fetchQueryAudits(
  filters: {
    sourceId?: string;
    status?: QueryAuditStatus;
    search?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ records: QueryAuditSummary[]; total: number }> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  return request(`/api/observatory/audits?${params}`);
}

export function fetchQueryAudit(id: string): Promise<QueryAuditRecord> {
  return request<{ record: QueryAuditRecord }>(
    `/api/observatory/audits/${encodeURIComponent(id)}`,
  ).then((body) => body.record);
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
  host: string;
  port: number;
  username: string;
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
  host?: string;
  port?: number;
  username?: string;
  password?: string;
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
  host?: string;
  port?: number;
  username?: string;
  password?: string;
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

export async function runObservatoryQuery(
  sourceId: string,
  question: string,
  history: HistoryTurn[] = [],
  onProgress?: (event: QueryProgressEvent) => void,
  signal?: AbortSignal,
): Promise<ObservatoryQueryResult> {
  const init: RequestInit = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(onProgress ? { accept: "text/event-stream" } : {}),
    },
    body: JSON.stringify({ sourceId, question, history }),
    ...(signal ? { signal } : {}),
  };
  if (!onProgress) return request("/api/observatory/query", init);
  const response = await fetch("/api/observatory/query", init);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return (await response.json()) as ObservatoryQueryResult;
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("查询响应为空");
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const parsed = parseSseBuffer(buffer.replace(/\r\n/g, "\n"));
      buffer = parsed.rest;
      for (const event of parsed.events) {
        if (event.type === "start" || event.type === "step") {
          onProgress(event as QueryProgressEvent);
        } else if (event.type === "result") {
          return event.result as ObservatoryQueryResult;
        } else if (event.type === "error") {
          throw new Error(String(event.error));
        }
      }
      if (done) throw new Error("查询连接中断，请在审计日志中查看执行状态");
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
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
import { parseSseBuffer } from "../../lib/api.js";
