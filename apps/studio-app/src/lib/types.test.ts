import { describe, expect, it } from "vitest";
import {
  emptyChatResources,
  normalizeChatResources,
  normalizeSession,
  normalizeSessions,
} from "./types";

describe("chat resource normalization", () => {
  it("fills resources when an older session has no resources field", () => {
    const session = {
      id: "legacy",
      title: "Legacy",
      messages: [],
      updatedAt: 1,
    };

    expect(normalizeSession(session)).toEqual({
      ...session,
      resources: emptyChatResources(),
    });
  });

  it("sanitizes malformed messages and session fields", () => {
    const normalized = normalizeSession({
      id: "  session-1  ",
      title: "  ",
      updatedAt: "bad",
      messages: [
        { id: "m1", role: "user", content: "hello", createdAt: 4 },
        { id: "m2", role: "invalid", content: "drop me" },
        null,
        {
          id: "m3",
          role: "assistant",
          content: 42,
          usage: { inputTokens: "bad" },
          toolCalls: [{ name: "search", arguments: { q: "x" } }],
        },
      ],
      resources: "bad",
    });

    expect(normalized.id).toBe("session-1");
    expect(normalized.title).toBe("New chat");
    expect(normalized.updatedAt).toEqual(expect.any(Number));
    expect(normalized.resources).toEqual(emptyChatResources());
    expect(normalized.messages).toHaveLength(2);
    expect(normalized.messages[1]).toMatchObject({
      role: "assistant",
      content: "",
      usage: { inputTokens: 0 },
      toolCalls: [{ name: "search", arguments: '{"q":"x"}' }],
    });
  });

  it("skips invalid cached sessions and duplicate ids", () => {
    const sessions = normalizeSessions([
      { id: "a", title: "A", messages: [], updatedAt: 1 },
      { id: "a", title: "Duplicate", messages: [], updatedAt: 2 },
      { title: "Missing id", messages: [], updatedAt: 1 },
      null,
      "invalid",
    ]);
    expect(sessions.map((session) => session.id)).toEqual(["a"]);
    expect(normalizeSessions({ sessions: [] })).toEqual([]);
  });

  it("rejects a session without an id", () => {
    expect(() => normalizeSession({ title: "Missing" })).toThrow("会话缺少有效 ID");
  });

  it("fills a missing rag binding", () => {
    expect(normalizeChatResources({ sqlSources: ["orders"], mcpTools: [] })).toEqual({
      mcpTools: [],
      rag: { sources: [], topK: 5 },
      sqlSources: ["orders"],
    });
  });

  it("supports empty and malformed resource objects", () => {
    expect(normalizeChatResources({})).toEqual(emptyChatResources());
    expect(normalizeChatResources(null)).toEqual(emptyChatResources());
    expect(normalizeChatResources("invalid")).toEqual(emptyChatResources());
  });

  it("filters invalid bindings, trims and deduplicates values", () => {
    expect(
      normalizeChatResources({
        rag: { sources: [" handbook ", "", 42, "handbook"], topK: 99 },
        sqlSources: ["orders", " orders ", null],
        mcpTools: [
          { serviceSlug: "search", toolName: "query" },
          { serviceSlug: " search ", toolName: " query " },
          { serviceSlug: "", toolName: "invalid" },
          null,
        ],
      }),
    ).toEqual({
      rag: { sources: ["handbook"], topK: 20 },
      sqlSources: ["orders"],
      mcpTools: [{ serviceSlug: "search", toolName: "query" }],
    });
  });

  it("clamps Top-K and restores its default when missing", () => {
    expect(normalizeChatResources({ rag: { topK: 0 } }).rag.topK).toBe(5);
    expect(normalizeChatResources({ rag: { topK: -3 } }).rag.topK).toBe(1);
    expect(normalizeChatResources({ rag: { topK: 3.9 } }).rag.topK).toBe(3);
  });
});
