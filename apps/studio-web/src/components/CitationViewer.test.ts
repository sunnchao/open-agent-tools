import { describe, expect, it } from "vitest";
import { locateChunk, matchHighlight, normalizeWhitespace } from "./CitationViewer.js";
import type { ChunkInfo } from "../features/rag/api.js";

function chunk(partial: Partial<ChunkInfo> & { chunkIndex: number; content: string }): ChunkInfo {
  return {
    id: `chunk-${partial.chunkIndex}`,
    source: "guide.md",
    length: partial.content.length,
    hasEmbedding: true,
    ...partial,
  };
}

describe("normalizeWhitespace", () => {
  it("collapse newlines and repeated spaces", () => {
    expect(normalizeWhitespace("a\n\nb   c")).toBe("a b c");
  });
});

describe("locateChunk", () => {
  const chunks = [
    chunk({ chunkIndex: 0, content: "第一段" }),
    chunk({ chunkIndex: 3, content: "第四段" }),
  ];

  it("finds the chunk by index regardless of array position", () => {
    expect(locateChunk(chunks, 3)?.content).toBe("第四段");
  });

  it("returns null when the index is gone", () => {
    expect(locateChunk(chunks, 9)).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(locateChunk([], 0)).toBeNull();
  });
});

describe("matchHighlight", () => {
  it("highlights the matched span and keeps the surrounding text", () => {
    const segments = matchHighlight("前缀-目标片段-后缀", "目标片段");
    expect(segments).toEqual([
      { text: "前缀-", highlight: false },
      { text: "目标片段", highlight: true },
      { text: "-后缀", highlight: false },
    ]);
  });

  it("matches across whitespace differences", () => {
    const segments = matchHighlight("alpha\n\n  beta gamma", "alpha beta");
    expect(segments.some((segment) => segment.highlight)).toBe(true);
    expect(segments.map((segment) => segment.text).join("")).toBe("alpha\n\n  beta gamma");
  });

  it("does not highlight when the citation is absent", () => {
    expect(matchHighlight("完全无关的内容", "目标片段")).toEqual([
      { text: "完全无关的内容", highlight: false },
    ]);
  });

  it("treats an empty citation as no highlight", () => {
    expect(matchHighlight("内容", "   ")).toEqual([{ text: "内容", highlight: false }]);
  });
});
