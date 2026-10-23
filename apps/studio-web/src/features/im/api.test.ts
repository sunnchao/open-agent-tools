import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchImAccounts,
  fetchImSqlSourceOptions,
  mcpToolKey,
  parseMcpToolKey,
  saveImChannel,
  updateImAccount,
} from "./api.js";

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("IM channel api", () => {
  it("maps schema sources down to the fields needed by the binding select", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            sources: [
              {
                id: "ops",
                name: "运维库",
                connector: "postgresql",
                databaseName: "ops",
                schemaName: "public",
                semanticProfile: "generic",
                isDefault: true,
                managedByEnv: false,
                syncStatus: "ready",
                lastSyncedAt: "2026-10-01T00:00:00.000Z",
                tableCount: 12,
                relationCount: 3,
              },
              {
                id: "crm",
                name: "CRM",
                connector: "mysql",
                isDefault: false,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchImSqlSourceOptions()).resolves.toEqual([
      { id: "ops", name: "运维库", connector: "postgresql", isDefault: true },
      { id: "crm", name: "CRM", connector: "mysql", isDefault: false },
    ]);
    expect(fetchMock).toHaveBeenCalledWith("/api/schema-sources", undefined);
  });

  it("throws the server error when schema sources fail to load", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "schema sources unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchImSqlSourceOptions()).rejects.toThrow("schema sources unavailable");
  });

  it("sends sqlSources when saving a channel", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            channel: {
              id: "channel-1",
              name: "研发群机器人",
              platform: "dingtalk",
              appId: "ding-app",
              appSecretMasked: "***",
              encryptKeyMasked: null,
              ragSources: ["docs"],
              sqlSources: ["ops"],
              mcpTools: [{ serviceSlug: "docs-mcp", toolName: "search" }],
              ragTopK: 5,
              requireMention: true,
              enabled: true,
              connected: false,
              createdAt: "2026-10-01T00:00:00.000Z",
              updatedAt: "2026-10-01T00:00:00.000Z",
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      saveImChannel({
        name: "研发群机器人",
        platform: "dingtalk",
        appId: "ding-app",
        appSecret: "secret",
        ragSources: ["docs"],
        sqlSources: ["ops"],
        mcpTools: [{ serviceSlug: "docs-mcp", toolName: "search" }],
        ragTopK: 5,
        requireMention: true,
        enabled: true,
      }),
    ).resolves.toMatchObject({ id: "channel-1", sqlSources: ["ops"] });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/im/channels",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"sqlSources":["ops"]'),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/im/channels",
      expect.objectContaining({
        body: expect.stringContaining(
          '"mcpTools":[{"serviceSlug":"docs-mcp","toolName":"search"}]',
        ),
      }),
    );
  });

  it("round-trips MCP tool keys", () => {
    const binding = { serviceSlug: "docs-mcp", toolName: "search" };
    expect(mcpToolKey(binding)).toBe("docs-mcp::search");
    expect(parseMcpToolKey("docs-mcp::search")).toEqual(binding);
    expect(parseMcpToolKey("no-separator")).toBeNull();
  });

  it("lists IM accounts with server-side filters and pagination", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            items: [],
            total: 0,
            limit: 20,
            offset: 40,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchImAccounts({
        channelId: "channel / 1",
        platform: "feishu",
        keyword: "alice",
        channelState: "deleted",
        limit: 20,
        offset: 40,
      }),
    ).resolves.toMatchObject({ total: 0 });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/im/accounts?channelId=channel+%2F+1&platform=feishu&keyword=alice&channelState=deleted&limit=20&offset=40",
      undefined,
    );
  });

  it("patches editable account fields and supports clearing a binding", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            account: {
              id: "account-1",
              bindingStatus: "unbound",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await updateImAccount("account / 1", {
      displayName: "VIP Alice",
      remark: "Priority",
      providerId: null,
      model: null,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/im/accounts/account%20%2F%201",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          displayName: "VIP Alice",
          remark: "Priority",
          providerId: null,
          model: null,
        }),
      }),
    );
  });
});
