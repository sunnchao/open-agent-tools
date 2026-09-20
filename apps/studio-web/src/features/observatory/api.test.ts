import { afterEach, describe, expect, it, vi } from "vitest";
import {
  duplicateSchemaSource,
  edgeIdsInSet,
  fetchObservatoryGraph,
  fetchSchemaCatalog,
  fetchSchemaSources,
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
