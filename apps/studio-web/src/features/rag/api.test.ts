import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadDocuments } from "./api.js";

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
      separators: ["\n\n", "。", " "],
    });

    const form = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/rag-api/documents");
    expect(form.get("chunkSize")).toBe("500");
    expect(form.get("chunkOverlap")).toBe("50");
    expect(JSON.parse(String(form.get("separators")))).toEqual(["\n\n", "。", " "]);
  });
});
