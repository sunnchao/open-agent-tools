import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getQualityReport,
  queryKnowledge,
  recallOptions,
  submitQueryFeedback,
  updateDocument,
  uploadDocuments,
} from "./api.js";

describe("RAG Studio API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uploads ordered separators as a JSON multipart field", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ files: 1, chunks: 2 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await uploadDocuments([new File(["content"], "notes.txt")], {
      chunkSize: 500,
      chunkOverlap: 50,
      chunkStrategy: "semantic",
      separators: ["\n\n", "。", " "],
      semanticThreshold: 0.72,
    });

    const form = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/admin/rag/documents");
    expect(form.get("chunkSize")).toBe("500");
    expect(form.get("chunkOverlap")).toBe("50");
    expect(form.get("chunkStrategy")).toBe("semantic");
    expect(JSON.parse(String(form.get("separators")))).toEqual(["\n\n", "。", " "]);
    expect(form.get("semanticThreshold")).toBe("0.72");
  });

  it("updates document metadata and query feedback", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    await updateDocument("guide.md", { title: "部署指南", tags: ["生产"] });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/admin/rag/documents/guide.md",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ title: "部署指南", tags: ["生产"] }),
      }),
    );

    await submitQueryFeedback("query/1", "negative", "来源错误");
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/admin/rag/query/query%2F1/feedback",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ rating: "negative", comment: "来源错误" }),
      }),
    );
  });

  it("loads the 7/30 day quality report through the admin proxy", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ periodDays: 30 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await getQualityReport(30);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/rag/analytics/quality-report?days=30",
      undefined,
    );
  });

  it("passes graph:false through to the query endpoint when graph enhancement is off", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ queryId: "q1", chunks: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await queryKnowledge({ query: "部署", topK: 5, generate: false, graph: false });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/rag/query",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ query: "部署", topK: 5, generate: false, graph: false }),
      }),
    );
  });

  it("sends graphHops together with the graph switch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ queryId: "q2", chunks: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await queryKnowledge({
      query: "部署",
      topK: 3,
      generate: true,
      sources: ["guide.md"],
      graph: true,
      graphHops: 3,
    });

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      query: "部署",
      topK: 3,
      generate: true,
      sources: ["guide.md"],
      graph: true,
      graphHops: 3,
    });
  });

  it("keeps the request body unchanged when graph options are omitted", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ queryId: "q3", chunks: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await queryKnowledge({ query: "部署", topK: 5, generate: false });

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      query: "部署",
      topK: 5,
      generate: false,
    });
  });
});

describe("recallOptions", () => {
  it("开启图谱检索时不传任何通道开关，沿用服务端默认", () => {
    expect(recallOptions(true)).toEqual({});
  });

  it("关闭图谱检索时同时关闭图谱与关键词，退化为仅向量召回", () => {
    expect(recallOptions(false)).toEqual({ graph: false, keyword: false });
  });

  it("仅向量模式的请求体同时含 graph:false 与 keyword:false", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ queryId: "q4", chunks: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await queryKnowledge({ query: "部署", topK: 5, generate: false, ...recallOptions(false) });

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      query: "部署",
      topK: 5,
      generate: false,
      graph: false,
      keyword: false,
    });
  });
});
