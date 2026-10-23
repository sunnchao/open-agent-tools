import { requestJson } from "./http.js";
import { consumeSse } from "./sse.js";
import type { GraphExport } from "@open-agent-tools/api-contracts/graph";
import type {
  ObservatoryGraphPayload,
  HistoryTurn,
  ObservatoryQueryResult,
  QueryStep,
  QueryAuditSummary,
  QueryAuditRecord,
  QueryAuditDetail,
  QueryProgressEvent,
  QueryAuditFilters,
  SchemaSourceConnector,
  SchemaSourceOption,
  SchemaSourceMetadata,
  SchemaCatalogPreview,
  SchemaSourceDraft,
} from "@open-agent-tools/api-contracts/observatory";
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
export function createObservatoryClient(
  transport: (path: string, init?: RequestInit) => Promise<Response>,
  options: {
    parseStreamError?: (response: Response) => Promise<string>;
    requireReadableBody?: boolean;
    requireResult?: boolean;
  } = {},
) {
  const request = <T>(path: string, init?: RequestInit) => requestJson<T>(transport, path, init);
  function fetchQueryAudits(
    filters: QueryAuditFilters = {},
  ): Promise<{ records: QueryAuditSummary[]; total: number }> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== "") params.set(key, String(value));
    }
    return request(`/api/observatory/audits?${params}`);
  }
  function fetchQueryAuditDetail(id: string): Promise<QueryAuditDetail> {
    return request<QueryAuditDetail>(`/api/observatory/audits/${encodeURIComponent(id)}`);
  }
  async function fetchQueryAudit(id: string): Promise<QueryAuditRecord> {
    return (await fetchQueryAuditDetail(id)).record;
  }
  function fetchSchemaSources(): Promise<SchemaSourceOption[]> {
    return request<{ sources: SchemaSourceOption[] }>("/api/schema-sources").then(
      (body) => body.sources,
    );
  }
  function fetchAdminSchemaSources(): Promise<SchemaSourceMetadata[]> {
    return request<{ sources: SchemaSourceMetadata[] }>("/api/admin/schema-sources").then(
      (body) => body.sources,
    );
  }
  function saveSchemaSource(input: SchemaSourceDraft): Promise<SchemaSourceMetadata> {
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
  function removeSchemaSource(id: string): Promise<void> {
    return request<void>(`/api/admin/schema-sources/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }
  function setDefaultSchemaSource(id: string): Promise<SchemaSourceMetadata> {
    return request<{ source: SchemaSourceMetadata }>(
      `/api/admin/schema-sources/${encodeURIComponent(id)}/default`,
      { method: "PUT" },
    ).then((body) => body.source);
  }
  function duplicateSchemaSource(id: string): Promise<SchemaSourceMetadata> {
    return request<{ source: SchemaSourceMetadata }>(
      `/api/admin/schema-sources/${encodeURIComponent(id)}/duplicate`,
      { method: "POST" },
    ).then((body) => body.source);
  }
  function syncSchemaSource(id: string): Promise<SchemaSourceMetadata> {
    return request<{ source: SchemaSourceMetadata }>(
      `/api/admin/schema-sources/${encodeURIComponent(id)}/sync`,
      { method: "POST" },
    ).then((body) => body.source);
  }
  function fetchSchemaCatalog(id: string): Promise<SchemaCatalogPreview> {
    return request(`/api/admin/schema-sources/${encodeURIComponent(id)}/catalog`);
  }
  function testSchemaSource(input: {
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
  function fetchObservatoryGraph(sourceId: string): Promise<ObservatoryGraphPayload> {
    return request(`/api/observatory/graph?sourceId=${encodeURIComponent(sourceId)}`);
  }
  function rebuildObservatoryGraph(sourceId: string): Promise<{
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
  async function runObservatoryQuery(
    sourceId: string,
    question: string,
    history: HistoryTurn[] = [],
    onProgress?: (event: QueryProgressEvent) => void,
    signal?: AbortSignal,
    originalQuestion?: string,
  ): Promise<ObservatoryQueryResult> {
    const init: RequestInit = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(onProgress ? { accept: "text/event-stream" } : {}),
      },
      body: JSON.stringify({
        sourceId,
        question,
        history,
        ...(originalQuestion ? { originalQuestion } : {}),
      }),
      ...(signal ? { signal } : {}),
    };
    if (!onProgress) return request("/api/observatory/query", init);
    return streamQuery(
      "/api/observatory/query",
      { sourceId, question, history, ...(originalQuestion ? { originalQuestion } : {}) },
      onProgress,
      signal,
    );
  }
  async function rerunObservatoryQuery(
    parentAuditId: string,
    sql: string,
    onProgress?: (event: QueryProgressEvent) => void,
    signal?: AbortSignal,
  ): Promise<ObservatoryQueryResult> {
    if (!onProgress) {
      return request("/api/observatory/query/rerun", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parentAuditId, sql }),
      });
    }
    return streamQuery("/api/observatory/query/rerun", { parentAuditId, sql }, onProgress, signal);
  }
  async function streamQuery(
    path: string,
    body: Record<string, unknown>,
    onProgress: (event: QueryProgressEvent) => void,
    signal?: AbortSignal,
  ): Promise<ObservatoryQueryResult> {
    const response = await transport(path, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      if (options.parseStreamError) throw new Error(await options.parseStreamError(response));
      const errorBody = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(errorBody.error ?? `HTTP ${response.status}`);
    }
    if (!response.headers.get("content-type")?.includes("text/event-stream")) {
      return (await response.json()) as ObservatoryQueryResult;
    }
    if (options.requireReadableBody !== false && !response.body?.getReader)
      throw new Error("查询响应为空");
    let result!: ObservatoryQueryResult;
    let completed = false;
    await consumeSse(response, (event) => {
      if (event.type === "start" || event.type === "step" || event.type === "clarification") {
        onProgress(event as QueryProgressEvent);
      } else if (event.type === "result") {
        result = event.result as ObservatoryQueryResult;
        completed = true;
        return true;
      } else if (event.type === "error") {
        throw new Error(String(event.error));
      }
    });
    if (completed && (!options.requireResult || result)) return result;
    throw new Error("查询连接中断，请在审计日志中查看执行状态");
  }
  return {
    fetchQueryAudits,
    fetchQueryAuditDetail,
    fetchQueryAudit,
    fetchSchemaSources,
    fetchAdminSchemaSources,
    saveSchemaSource,
    removeSchemaSource,
    setDefaultSchemaSource,
    duplicateSchemaSource,
    syncSchemaSource,
    fetchSchemaCatalog,
    testSchemaSource,
    fetchObservatoryGraph,
    rebuildObservatoryGraph,
    runObservatoryQuery,
    rerunObservatoryQuery,
  };
}
