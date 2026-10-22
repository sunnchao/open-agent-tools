import { describe, expect, it } from "vitest";
import { channelLabels, channelSummary } from "./channelLabel";

describe("channel label", () => {
  it("maps every single channel with its theme color", () => {
    expect(channelLabels(["vector"])).toEqual([
      { channel: "vector", label: "向量", color: "primary" },
    ]);
    expect(channelLabels(["keyword"])).toEqual([
      { channel: "keyword", label: "关键词", color: "secondary" },
    ]);
    expect(channelLabels(["graph"])).toEqual([
      { channel: "graph", label: "图谱", color: "tertiary" },
    ]);
  });

  it("maps multi-channel combinations in stable order", () => {
    expect(channelSummary(["keyword", "vector"])).toBe("向量+关键词");
    expect(channelSummary(["graph", "keyword"])).toBe("关键词+图谱");
    expect(channelSummary(["graph", "vector"])).toBe("向量+图谱");
    expect(channelSummary(["graph", "keyword", "vector"])).toBe("向量+关键词+图谱");
  });

  it("degrades safely for missing or unknown channels", () => {
    expect(channelLabels(undefined)).toEqual([]);
    expect(channelLabels([])).toEqual([]);
    expect(channelSummary(["bogus"])).toBe("");
  });

  it("deduplicates repeated channels", () => {
    expect(channelSummary(["graph", "graph", "vector"])).toBe("向量+图谱");
  });
});
