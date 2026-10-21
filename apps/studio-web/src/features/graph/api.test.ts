import { afterEach, describe, expect, it, vi } from "vitest";
import { documentGraph, neighborsOf, retrieveGraph } from "./api.js";

describe("document-scoped Graph API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads a complete document graph through the admin proxy", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ nodes: [], edges: [] }) });
    vi.stubGlobal("fetch", fetchMock);
    await documentGraph("目录/产品 100%.md");
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/admin/rag/graph/documents/${encodeURIComponent("目录/产品 100%.md")}`,
      undefined,
    );
  });

  it("sends the selected documents instead of searching the whole library", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    await retrieveGraph("topic", 2, ["guide.md"]);
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/rag/graph/retrieve", expect.objectContaining({
      body: JSON.stringify({ query: "topic", maxHops: 2, sources: ["guide.md"] }),
    }));
    await retrieveGraph("topic", 2, []);
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string).sources).toEqual([]);
  });

  it("keeps neighbor expansion inside the selected document", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    await neighborsOf("entity/1", 2, "产品 100%.md");
    const params = new URLSearchParams({ hops: "2", source: "产品 100%.md" });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/admin/rag/graph/neighbors/entity%2F1?${params}`,
      undefined,
    );
  });
});
