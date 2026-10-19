import { afterEach, describe, expect, it, vi } from "vitest";
import { getQualityReport, submitQueryFeedback, updateDocument, uploadDocuments } from "./api.js";

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
});
