import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteDocument,
  getAnalyticsOverview,
  getQualityReport,
  listChunks,
  listDocuments,
  queryKnowledge,
  recallOptions,
  submitQueryFeedback,
  updateDocument,
  uploadDocuments,
} from "./rag";
import { setAuthMemory, __resetAuth } from "../lib/http";
import { setStorageBackend } from "../lib/storage";

describe("rag api", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetAuth();
    setStorageBackend({
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async () => {},
    });
  });
  it("covers documents/chunks/query/feedback paths", async () => {
    setAuthMemory({ agentUrl: "http://a:3000" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ sources: [], chunks: 0 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ source: "g", chunks: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ document: { source: "g" } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, source: "g" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ queryId: "q", chunks: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ totals: {} }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ periodDays: 30 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ feedback: {} }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ files: 1, chunks: 2 }) });
    vi.stubGlobal("fetch", fetchMock);
    await listDocuments();
    await listChunks("g");
    await updateDocument("g", { title: "t" });
    await deleteDocument("g");
    await queryKnowledge({ query: "q", topK: 5, generate: false });
    await getAnalyticsOverview(14);
    await getQualityReport(30);
    await submitQueryFeedback("q", "positive");
    await uploadDocuments([{ name: "a.txt", data: "hi" }], {
      chunkSize: 500,
      chunkOverlap: 50,
      chunkStrategy: "fixed",
      separators: ["\n"],
      semanticThreshold: 0.5,
    });
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls[0]).toBe("http://a:3000/api/admin/rag/documents");
    expect(urls[4]).toBe("http://a:3000/api/admin/rag/query");
    expect(fetchMock.mock.calls[8]?.[1]?.body).toBeInstanceOf(FormData);
  });

  it("passes graph toggle and hops through to the query endpoint", async () => {
    setAuthMemory({ agentUrl: "http://a:3000" });
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ queryId: "q", chunks: [] }) });
    vi.stubGlobal("fetch", fetchMock);
    await queryKnowledge({ query: "q", topK: 5, generate: false, graph: false });
    await queryKnowledge({ query: "q", topK: 5, generate: false, graphHops: 3 });
    const bodies = fetchMock.mock.calls.map((call) =>
      JSON.parse(String((call[1] as RequestInit | undefined)?.body)),
    );
    expect(bodies[0]).toMatchObject({ query: "q", graph: false });
    expect(bodies[1]).toMatchObject({ query: "q", graphHops: 3 });
  });

  it("关闭图谱检索时同时关闭关键词通道，退化为仅向量召回", () => {
    expect(recallOptions(true)).toEqual({});
    expect(recallOptions(false)).toEqual({ graph: false, keyword: false });
  });
});
