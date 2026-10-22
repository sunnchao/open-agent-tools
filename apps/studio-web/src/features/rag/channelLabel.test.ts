import { describe, expect, it } from "vitest";
import { channelLabel, normalizeChannels } from "./channelLabel.js";

describe("normalizeChannels", () => {
  it("orders channels as vector → keyword → graph regardless of input order", () => {
    expect(normalizeChannels(["graph", "keyword", "vector"])).toEqual([
      "vector",
      "keyword",
      "graph",
    ]);
  });

  it("drops duplicates and unknown values", () => {
    expect(normalizeChannels(["keyword", "keyword", "unknown"])).toEqual(["keyword"]);
  });

  it("returns an empty array for legacy hits without channels", () => {
    expect(normalizeChannels([])).toEqual([]);
  });
});

describe("channelLabel", () => {
  it("labels each single channel", () => {
    expect(channelLabel(["vector"])).toEqual({ label: "仅向量", color: "blue" });
    expect(channelLabel(["keyword"])).toEqual({ label: "仅关键词", color: "green" });
    expect(channelLabel(["graph"])).toEqual({ label: "仅图谱", color: "volcano" });
  });

  it("labels the legacy two-way hits", () => {
    expect(channelLabel(["vector", "keyword"])).toEqual({ label: "双路命中", color: "purple" });
    expect(channelLabel(["keyword", "vector"])).toEqual({ label: "双路命中", color: "purple" });
  });

  it("labels graph combinations with the other channels", () => {
    expect(channelLabel(["vector", "graph"])).toEqual({ label: "向量+图谱", color: "cyan" });
    expect(channelLabel(["graph", "keyword"])).toEqual({ label: "关键词+图谱", color: "orange" });
  });

  it("labels all three channels", () => {
    expect(channelLabel(["graph", "vector", "keyword"])).toEqual({
      label: "三路命中",
      color: "gold",
    });
  });

  it("falls back to RRF when channels are missing or unknown", () => {
    expect(channelLabel([])).toEqual({ label: "RRF", color: "default" });
    expect(channelLabel(["hybrid"])).toEqual({ label: "RRF", color: "default" });
  });

  it("ignores unknown extras when a known combination exists", () => {
    expect(channelLabel(["vector", "keyword", "graph", "rerank"])).toEqual({
      label: "三路命中",
      color: "gold",
    });
  });
});
