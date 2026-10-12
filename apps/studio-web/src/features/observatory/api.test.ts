import { afterEach, describe, expect, it, vi } from "vitest";
import {
  duplicateSchemaSource,
  edgeIdsInSet,
  fetchObservatoryGraph,
  fetchSchemaCatalog,
  fetchSchemaSources,
  fetchQueryAudit,
  fetchQueryAudits,
  pendingQuerySteps,
  runObservatoryQuery,
  syncSchemaSource,
  walkChain,
  type GraphEdge,
  type GraphNode,
} from "./api.js";

afterEach(() => vi.unstubAllGlobals());

const nodes: GraphNode[] = [
  { id: "u", name: "users", type: "table" },
  { id: "l", name: "logs", type: "table" },
  { id: "t", name: "tokens", type: "table" },
  { id: "c", name: "channels", type: "table" },
];
const edges: GraphEdge[] = [
  { id: "e1", source: "l", target: "u", relType: "user_id", weight: 1 },
  { id: "e2", source: "l", target: "t", relType: "token_id", weight: 1 },
  { id: "e3", source: "t", target: "u", relType: "user_id", weight: 1 },
  { id: "e4", source: "c", target: "u", relType: "user_id", weight: 1 },
];

describe("observatory api", () => {
  it("streams split UTF-8 events, progress, and the final query result", async () => {
    const steps = pendingQuerySteps();
    const step = { ...steps[0]!, status: "succeeded" };
    const result = { sourceId: "ops", question: "中文问题", auditId: "audit-1", steps };
    const wire = new TextEncoder().encode(
      [
        ": heartbeat\r\n\r\n",
        `data: ${JSON.stringify({ type: "start", auditId: "audit-1", steps })}\r\n\r\n`,
        `data: ${JSON.stringify({ type: "step", auditId: "audit-1", step })}\r\n\r\n`,
        `data: ${JSON.stringify({ type: "result", result })}\r\n\r\n`,
      ].join(""),
    );
    const fetchMock = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (let index = 0; index < wire.length; index += 7) {
                controller.enqueue(wire.slice(index, index + 7));
              }
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const progress = vi.fn();
    await expect(runObservatoryQuery("ops", "中文问题", [], progress)).resolves.toEqual(result);
    expect(progress).toHaveBeenCalledTimes(2);
    expect(progress).toHaveBeenLastCalledWith({ type: "step", auditId: "audit-1", step });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/observatory/query",
      expect.objectContaining({
        headers: { "content-type": "application/json", accept: "text/event-stream" },
      }),
    );
  });

  it("reports incomplete streams and server stream errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(": heartbeat\n\n", {
            headers: { "content-type": "text/event-stream" },
          }),
      ),
    );
    await expect(runObservatoryQuery("ops", "问题", [], vi.fn())).rejects.toThrow("连接中断");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(`data: ${JSON.stringify({ type: "error", error: "写入审计失败" })}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          }),
      ),
    );
    await expect(runObservatoryQuery("ops", "问题", [], vi.fn())).rejects.toThrow("写入审计失败");
  });

  it("loads filtered paginated audit summaries and encoded audit details", async () => {
    const fetchMock = vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes("audits?") ? { records: [], total: 0 } : { record: { id: "a/b" } },
          ),
          { headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      fetchQueryAudits({
        sourceId: "ops/source",
        status: "failed",
        search: "用户",
        limit: 20,
        offset: 20,
      }),
    ).resolves.toEqual({ records: [], total: 0 });
    const url = new URL(fetchMock.mock.calls[0]![0], "http://localhost");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      sourceId: "ops/source",
      status: "failed",
      search: "用户",
      limit: "20",
      offset: "20",
    });
    await expect(fetchQueryAudit("a/b")).resolves.toEqual({ id: "a/b" });
    expect(fetchMock).toHaveBeenLastCalledWith("/api/observatory/audits/a%2Fb", undefined);
  });

  it("loads schema graph from the demo endpoint", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            source: {
              id: "ops",
              name: "运营库",
              connector: "mysql",
              endpoint: "db/oneapi",
              databaseName: "oneapi",
              tableFilter: [],
              semanticProfile: "oneapi",
              enabled: true,
              isDefault: true,
              managedByEnv: false,
              hasCredential: true,
              createdAt: "",
              updatedAt: "",
            },
            database: "oneapi",
            collectedAt: "2026-09-18T00:00:00Z",
            tables: [],
            graph: { nodes: [], edges: [], stats: { entities: 0, relations: 0 } },
            stats: { entities: 0, relations: 0 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchObservatoryGraph("ops")).resolves.toMatchObject({ database: "oneapi" });
    expect(fetchMock).toHaveBeenCalledWith("/api/observatory/graph?sourceId=ops", undefined);
  });

  it("posts question and history to query", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        sourceId: "ops",
        question: "渠道权重",
        history: [{ role: "assistant", content: "哪个字段？" }],
      });
      return new Response(
        JSON.stringify({
          sourceId: "ops",
          question: "渠道权重",
          selectedTables: ["channels"],
          schemaPrompt: "",
          graph: { nodes: [], edges: [], stats: { entities: 0, relations: 0 } },
          seeds: [],
          formattedGraph: "",
          sql: "SELECT weight FROM channels",
          durationMs: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await runObservatoryQuery("ops", "渠道权重", [
      { role: "assistant", content: "哪个字段？" },
    ]);
    expect(result.sql).toMatch(/weight/);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/observatory/query",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("lists configured schema sources", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ sources: [{ id: "a", name: "A" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchSchemaSources()).resolves.toEqual([{ id: "a", name: "A" }]);
    expect(fetchMock).toHaveBeenCalledWith("/api/schema-sources", undefined);
  });

  it("uses source-scoped admin endpoints for duplicate, sync, and catalog preview", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/catalog")) {
        return new Response(
          JSON.stringify({
            sourceId: "a/b",
            database: "db",
            collectedAt: "",
            relationCount: 0,
            tables: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ source: { id: "a/b" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    await duplicateSchemaSource("a/b");
    await syncSchemaSource("a/b");
    await fetchSchemaCatalog("a/b");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/admin/schema-sources/a%2Fb/duplicate",
      "/api/admin/schema-sources/a%2Fb/sync",
      "/api/admin/schema-sources/a%2Fb/catalog",
    ]);
  });
});

describe("observatory chain helpers", () => {
  it("walks two hops from a clicked edge", () => {
    const chain = walkChain(edges, nodes, ["logs", "users"], 2);
    expect(chain.has("logs")).toBe(true);
    expect(chain.has("users")).toBe(true);
    expect(chain.has("tokens")).toBe(true);
  });

  it("collects edges whose both ends are in the chain", () => {
    const names = walkChain(edges, nodes, ["logs", "users"], 1);
    const ids = edgeIdsInSet(edges, nodes, names);
    expect(ids.has("e1")).toBe(true);
    expect(ids.has("e2")).toBe(true);
  });
});
