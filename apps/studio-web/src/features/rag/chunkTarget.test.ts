import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumePendingChunkTarget,
  requestOpenChunk,
  subscribeChunkTarget,
} from "./chunkTarget.js";

describe("chunkTarget", () => {
  afterEach(() => {
    consumePendingChunkTarget();
    vi.restoreAllMocks();
  });

  it("delivers to an already-mounted subscriber", () => {
    const handler = vi.fn();
    const unsubscribe = subscribeChunkTarget(handler);
    requestOpenChunk({ source: "guide.md", chunkIndex: 2 });
    expect(handler).toHaveBeenCalledWith({ source: "guide.md", chunkIndex: 2 });
    unsubscribe();
  });

  it("redelivers a pending target to a late subscriber", () => {
    requestOpenChunk({ source: "faq.md", chunkIndex: 5 });
    const handler = vi.fn();
    const unsubscribe = subscribeChunkTarget(handler);
    expect(handler).toHaveBeenCalledWith({ source: "faq.md", chunkIndex: 5 });
    unsubscribe();
  });

  it("stops notifying after unsubscribe", () => {
    const handler = vi.fn();
    const unsubscribe = subscribeChunkTarget(handler);
    handler.mockClear();
    unsubscribe();
    requestOpenChunk({ source: "guide.md", chunkIndex: 1 });
    expect(handler).not.toHaveBeenCalled();
  });

  it("consumes a pending target exactly once", () => {
    requestOpenChunk({ source: "guide.md", chunkIndex: 4 });
    expect(consumePendingChunkTarget()).toEqual({ source: "guide.md", chunkIndex: 4 });
    expect(consumePendingChunkTarget()).toBeNull();
  });
});
