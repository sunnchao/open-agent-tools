import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listEntities,
  neighborsOf,
  reconcileGraph,
  relationTypes,
  retrieveGraph,
  syncStatus,
} from "./graph";
import { setAuthMemory, __resetAuth } from "../lib/http";
import { setStorageBackend } from "../lib/storage";

describe("graph api", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetAuth();
    setStorageBackend({
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async () => {},
    });
  });
  it("covers retrieve/neighbors/entities/types/sync/reconcile", async () => {
    setAuthMemory({ agentUrl: "http://a:3000" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ seeds: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ nodes: [], edges: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ entities: [], stats: {} }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ types: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ inSync: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ rebuilt: [] }) });
    vi.stubGlobal("fetch", fetchMock);
    await retrieveGraph("q");
    await neighborsOf("e1");
    await listEntities({ search: "a" });
    await relationTypes();
    await syncStatus();
    await reconcileGraph();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://a:3000/api/admin/rag/graph/retrieve");
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("/graph/entities?");
  });
});
