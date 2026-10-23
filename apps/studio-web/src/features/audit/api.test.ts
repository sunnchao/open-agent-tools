import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchAuditOverview,
  fetchAuditDetail,
  fetchImChatAuditDetail,
  fetchImChatAudits,
  fetchMcpAuditEvents,
  fetchQueryAuditSummaries,
  fetchUsageEvents,
  normalizeImChatAudit,
  toTimestamp,
} from "./api.js";

afterEach(() => vi.unstubAllGlobals());

describe("audit api", () => {
  it("sends every IM audit filter and normalizes the items envelope", async () => {
    const fetchMock = vi.fn(
      async (_url: string) =>
        new Response(
          JSON.stringify({
            items: [
              {
                id: "audit-1",
                workspace: "w-team",
                platform: "dingtalk",
                channelId: "ch-1",
                channelName: "研发群",
                actor: "u-9",
                actorName: "张三",
                chatType: "group",
                question: "本月用量",
                answer: "共 100",
                status: "ok",
                createdAt: 1780000000000,
                durationMs: 1200,
                toolCalls: 2,
                citations: 1,
              },
            ],
            total: 1,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchImChatAudits({
      workspace: "w-team",
      platform: "dingtalk",
      channelId: "ch-1",
      actor: "u-9",
      chatType: "group",
      status: "ok",
      from: 1780000000000,
      to: 1782591999999,
      keyword: "用量",
      limit: 20,
      offset: 20,
    });

    expect(result.total).toBe(1);
    expect(result.records[0]).toMatchObject({
      id: "audit-1",
      platform: "dingtalk",
      citationCount: 1,
      createdAt: new Date(1780000000000).toISOString(),
    });
    const url = new URL(fetchMock.mock.calls[0]![0], "http://localhost");
    expect(url.pathname).toBe("/api/admin/audit/im/audits");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      workspace: "w-team",
      platform: "dingtalk",
      channelId: "ch-1",
      actor: "u-9",
      chatType: "group",
      status: "ok",
      from: "1780000000000",
      to: "1782591999999",
      keyword: "用量",
      limit: "20",
      offset: "20",
    });
  });

  it("converts ISO time filters into the millisecond timestamps the server expects", () => {
    expect(toTimestamp("2026-10-01T00:00:00.000Z")).toBe(Date.parse("2026-10-01T00:00:00.000Z"));
    expect(toTimestamp(1780000000000)).toBe(1780000000000);
    expect(toTimestamp("")).toBeUndefined();
    expect(toTimestamp("not-a-date")).toBeUndefined();
  });

  it("reads the detail endpoint and keeps tools and citations", async () => {
    const fetchMock = vi.fn(
      async (_url: string) =>
        new Response(
          JSON.stringify({
            audit: {
              id: "audit-2",
              question: "问题全文",
              answer: "回答全文",
              tools: ["sql.query"],
              citations: [{ title: "文档", url: "https://example.com" }],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const detail = await fetchImChatAuditDetail("audit-2");
    expect(detail.question).toBe("问题全文");
    expect(detail.tools).toEqual(["sql.query"]);
    expect(detail.citations).toEqual([{ title: "文档", url: "https://example.com", snippet: "" }]);
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/audit/im/audits/audit-2", undefined);
  });

  it("loads IM details in the record workspace and preserves session identifiers", async () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key.endsWith("workspace-id") ? "w-global" : null),
    });
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            audit: {
              id: "im/1",
              workspace: "w-team",
              session_id: "session-1",
              conversationId: "group-1",
            },
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const detail = await fetchAuditDetail({ kind: "im", id: "im/1", workspace: "w-team" });
    expect(detail).toMatchObject({
      kind: "im",
      record: { sessionId: "session-1", conversationId: "group-1", workspace: "w-team" },
    });
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/admin/audit/im/audits/im%2F1");
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get("x-workspace-id")).toBe("w-team");
  });

  it("loads full query details with the selected workspace instead of the global workspace", async () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key.endsWith("workspace-id") ? "w-global" : null),
    });
    const query = { record: { id: "q/1", executedSql: "SELECT 1" }, parent: null, children: [] };
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(query)),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchAuditDetail({ kind: "query", id: "q/1", workspace: "w-team" }),
    ).resolves.toEqual({ kind: "query", detail: query });
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/observatory/audits/q%2F1");
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get("x-workspace-id")).toBe("w-team");
  });

  it("loads full MCP payloads from the control plane", async () => {
    const event = { id: "mcp/1", input: { query: "hello" }, output: { ok: true }, context: null };
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({ event })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAuditDetail({ kind: "mcp", id: "mcp/1" })).resolves.toEqual({
      kind: "mcp",
      record: event,
    });
    expect(fetchMock.mock.calls[0]![0]).toBe("/mcp-api/audit/mcp%2F1");
  });

  it("shows the complete usage event without an extra network request", async () => {
    const event = {
      id: "usage-1",
      kind: "chat" as const,
      requests: 2,
      inputTokens: 12,
      outputTokens: 4,
      toolCalls: 0,
      durationMs: 200,
      status: "ok" as const,
      createdAt: 1780000000000,
      sessionId: "session-1",
      workspaceId: "w-team",
      model: "test-model",
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchAuditDetail({ kind: "usage", event })).resolves.toEqual({
      kind: "usage",
      record: event,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces missing audit records as an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "审计记录不存在" }), { status: 404 })),
    );
    await expect(fetchAuditDetail({ kind: "query", id: "missing" })).rejects.toThrow(
      "审计记录不存在",
    );
  });

  it("throws the server error message when the IM audit list fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string) =>
          new Response(JSON.stringify({ error: "audit unavailable" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    await expect(fetchImChatAudits()).rejects.toThrow("audit unavailable");
  });

  it("normalizes alternative field names into the stable record shape", () => {
    const record = normalizeImChatAudit({
      auditId: "a-1",
      workspaceId: "w-1",
      platform: "feishu",
      actorId: "u-1",
      conversationType: "p2p",
      prompt: "问",
      response: "答",
      outcome: "ok",
      started_at: "2026-10-01T00:00:00.000Z",
      latency_ms: 30,
      tool_call_count: 4,
      reference_count: 2,
    });
    expect(record).toMatchObject({
      id: "a-1",
      workspace: "w-1",
      actor: "u-1",
      chatType: "p2p",
      question: "问",
      answer: "答",
      status: "ok",
      durationMs: 30,
      toolCalls: 4,
      citationCount: 2,
    });
  });

  it("normalizes token usage and per-model details", () => {
    const record = normalizeImChatAudit({
      platform: "dingtalk",
      provider_id: "provider-1",
      provider_name: "主 Provider",
      provider_format: "openai-chat",
      model: "model-1",
      llm_requests: 2,
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
      models: JSON.stringify([
        {
          providerId: "provider-1",
          model: "model-1",
          requests: 2,
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          durationMs: 800,
          failed: false,
        },
      ]),
    });
    expect(record).toMatchObject({
      providerId: "provider-1",
      providerName: "主 Provider",
      providerFormat: "openai-chat",
      model: "model-1",
      llmRequests: 2,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    });
    expect(record.models).toEqual([
      {
        providerId: "provider-1",
        model: "model-1",
        requests: 2,
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        durationMs: 800,
        failed: false,
      },
    ]);
  });

  it("loads the audit overview sections and keeps the control plane note", async () => {
    const fetchMock = vi.fn(
      async (_url: string) =>
        new Response(
          JSON.stringify({
            sections: [{ key: "im", title: "IM 会话审计", total: 3, items: [] }],
            note: "MCP 平台审计由 Control Plane 持有",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const overview = await fetchAuditOverview({ workspace: "w-1", limit: 5 });
    expect(overview.sections).toHaveLength(1);
    expect(overview.note).toContain("Control Plane");
    const url = new URL(fetchMock.mock.calls[0]![0], "http://localhost");
    expect(url.pathname).toBe("/api/admin/audit/overview");
    expect(Object.fromEntries(url.searchParams)).toEqual({ workspace: "w-1", limit: "5" });
  });

  it("reuses the usage events endpoint of the main service", async () => {
    const fetchMock = vi.fn(
      async (_url: string) =>
        new Response(JSON.stringify({ events: [{ id: "e-1", kind: "chat" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchUsageEvents({ limit: 20 })).resolves.toHaveLength(1);
    const url = new URL(fetchMock.mock.calls[0]![0], "http://localhost");
    expect(url.pathname).toBe("/api/admin/usage/events");
    expect(url.searchParams.get("limit")).toBe("20");
  });

  it("scopes the workspace by the x-workspace-id header on the main service", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ records: [], total: 0, events: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchQueryAuditSummaries({ limit: 20, offset: 0 }, "w-team");
    const url = new URL(fetchMock.mock.calls[0]![0], "http://localhost");
    expect(url.pathname).toBe("/api/observatory/audits");
    const headers = new Headers(fetchMock.mock.calls[0]![1]?.headers);
    expect(headers.get("x-workspace-id")).toBe("w-team");

    await fetchUsageEvents({ limit: 5, workspace: "w-team" });
    const usageHeaders = new Headers(fetchMock.mock.calls[1]![1]?.headers);
    expect(usageHeaders.get("x-workspace-id")).toBe("w-team");
  });

  it("reads MCP audit events from the control plane prefix", async () => {
    const fetchMock = vi.fn(
      async (_url: string) =>
        new Response(JSON.stringify({ events: [{ id: "mcp-1", action: "service.publish" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const events = await fetchMcpAuditEvents();
    expect(events).toHaveLength(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/mcp-api/audit");
  });

  it("surfaces the control plane failure so the caller can degrade the tab", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string) =>
          new Response(
            JSON.stringify({ error: { code: "UPSTREAM", message: "control plane down" } }),
            {
              status: 502,
              headers: { "content-type": "application/json" },
            },
          ),
      ),
    );
    await expect(fetchMcpAuditEvents()).rejects.toThrow("control plane down");
  });
});
