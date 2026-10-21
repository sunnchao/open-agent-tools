import { afterEach, describe, expect, it, vi } from "vitest";
import {
  edgeIdsInSet,
  fetchQueryAuditDetail,
  fetchQueryAudits,
  fetchSchemaSources,
  neighborsOf,
  rerunObservatoryQuery,
  runObservatoryQuery,
  walkChain,
} from "./observatory";
import { setAuthMemory, __resetAuth } from "../lib/http";
import { setStorageBackend } from "../lib/storage";

describe("observatory api", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetAuth();
    setStorageBackend({
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async () => {},
    });
  });
  it("queries without SSE when no progress callback", async () => {
    setAuthMemory({ agentUrl: "http://a:3000" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ rows: [{ a: 1 }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ rows: [] }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const r = await runObservatoryQuery("s1", "q");
    expect((r.rows ?? []).length).toBe(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://a:3000/api/observatory/query");
    await rerunObservatoryQuery("p1", "select 1");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://a:3000/api/observatory/query/rerun");
  });
  it("streams progress events then resolves the result", async () => {
    setAuthMemory({ agentUrl: "http://a:3000" });
    const text =
      'data: {"type":"start","auditId":"a","steps":[]}\n\ndata: {"type":"result","result":{"sourceId":"s","question":"q","selectedTables":[],"schemaPrompt":"","graph":{"nodes":[],"edges":[],"stats":{"entities":0,"relations":0}},"seeds":[],"formattedGraph":"","durationMs":1}}\n\n';
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: stream,
      }),
    );
    const seen: string[] = [];
    const r = await runObservatoryQuery("s", "q", [], (e) => {
      seen.push(e.type);
    });
    expect(seen).toEqual(["start"]);
    expect(r.auditId).toBeUndefined();
    expect(r.sourceId).toBe("s");
  });
  it("lists audits and schema sources", async () => {
    setAuthMemory({ agentUrl: "http://a:3000" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ records: [], total: 0 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ record: { id: "a" }, parent: null, children: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ sources: [{ id: "s" }] }),
      });
    vi.stubGlobal("fetch", fetchMock);
    expect((await fetchQueryAudits({ status: "succeeded" })).total).toBe(0);
    expect((await fetchQueryAuditDetail("a")).record.id).toBe("a");
    expect((await fetchSchemaSources())[0]?.id).toBe("s");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/observatory/audits?");
  });
  it("walks local graph helpers", () => {
    const nodes = [
      { id: "1", name: "a", type: "t" },
      { id: "2", name: "b", type: "t" },
    ];
    const edges = [{ id: "e", source: "1", target: "2", relType: "r", weight: 1 }];
    expect(neighborsOf(edges, "a", nodes)).toEqual(["b"]);
    expect(walkChain(edges, nodes, ["a"], 1).has("b")).toBe(true);
    expect(edgeIdsInSet(edges, nodes, new Set(["a", "b"])).has("e")).toBe(true);
  });
});
