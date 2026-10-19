import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addPrompt,
  buildToolSlaQuery,
  buildVersion,
  createApiKey,
  createClient,
  deleteGrant,
  deletePrompt,
  deleteService,
  deleteTool,
  disableService,
  enableService,
  forkDraftVersion,
  getServiceEnvironment,
  getAuditEvent,
  getToolSla,
  McpApiError,
  listClientQuotas,
  listClientUsage,
  listMarketplaceServices,
  listApiKeys,
  listAuditEvents,
  listBuilds,
  listClients,
  listGrants,
  publishVersion,
  resetVersionToDraft,
  revokeApiKey,
  rollbackVersion,
  updatePrompt,
  updateService,
  updateServiceEnvironment,
  updateTool,
  updateVersionLimits,
  upsertClientQuota,
  upsertGrant,
  uploadArtifact,
  validateVersion,
} from "./api.js";

describe("MCP Studio API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads complete audit event input and output on demand", async () => {
    const event = {
      id: "event-1",
      input: { query: "MCP" },
      output: { content: [{ type: "text", text: "完整输出" }] },
      context: { limits: { network: "bridge" } },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ event }) });
    vi.stubGlobal("fetch", fetchMock);
    await expect(getAuditEvent("event-1")).resolves.toEqual(event);
    expect(fetchMock).toHaveBeenCalledWith("/mcp-api/audit/event-1", expect.any(Object));
  });

  it("saves execution limits with the expected version revision", async () => {
    const limits = { timeoutMs: 15_000, memoryMb: 512, cpuMillis: 500, network: "bridge" as const };
    const version = { id: "version-1", revision: 5, limits };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ version }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateVersionLimits("service-1", "version-1", 4, limits)).resolves.toEqual(
      version,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/mcp-api/services/service-1/versions/version-1/limits",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ expectedRevision: 4, limits }),
      }),
    );
  });

  it("uploads a ZIP through the presigned URL before completing artifact inspection", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          objectKey: "services/service-1/version-1/package.zip",
          upload: {
            url: "https://objects.example/package",
            method: "PUT",
            headers: { "content-type": "application/zip", "x-checksum": "digest" },
          },
        }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({
        ok: true,
        status: 202,
        json: async () => ({ version: { id: "version-1", status: "VALIDATING" }, job: {} }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["zip-bytes"], "tools.zip", { type: "application/zip" });

    await uploadArtifact("service-1", "version-1", 4, file);

    const requestedBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      sha256: string;
      size: number;
    };
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/mcp-api/services/service-1/versions/version-1/upload-url",
    );
    expect(requestedBody.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(requestedBody.size).toBe(file.size);
    expect(fetchMock.mock.calls[1]).toEqual([
      "https://objects.example/package",
      expect.objectContaining({
        method: "PUT",
        body: file,
        headers: { "content-type": "application/zip", "x-checksum": "digest" },
      }),
    ]);
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "/mcp-api/services/service-1/versions/version-1/complete-upload",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      objectKey: "services/service-1/version-1/package.zip",
      sha256: requestedBody.sha256,
      size: file.size,
      expectedRevision: 4,
    });
  });

  it("sends optimistic revisions for the complete version lifecycle", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ version: {}, service: {}, job: {} }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await buildVersion("service-1", "version-1", 2);
    await validateVersion("service-1", "version-1", 3);
    await resetVersionToDraft("service-1", "version-1", 4);
    await forkDraftVersion("service-1", "version-1");
    await publishVersion("service-1", "version-1", 5);
    await rollbackVersion("service-1", "version-1", 6);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/mcp-api/services/service-1/versions/version-1/build",
      "/mcp-api/services/service-1/versions/version-1/validate",
      "/mcp-api/services/service-1/versions/version-1/reset-to-draft",
      "/mcp-api/services/service-1/versions/version-1/fork-draft",
      "/mcp-api/services/service-1/versions/version-1/publish",
      "/mcp-api/services/service-1/versions/version-1/rollback",
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { expectedRevision: 2 },
      { expectedRevision: 3 },
      { expectedRevision: 4 },
      {},
      { expectedRevision: 5 },
      { expectedRevision: 6 },
    ]);
  });

  it("reads masked environment variables and saves values with a service revision", async () => {
    const payload = { environment: { TAVILY_API_KEY: null }, revision: 3 };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => payload,
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await getServiceEnvironment("service-1")).toEqual(payload);
    expect(
      await updateServiceEnvironment("service-1", 2, {
        TAVILY_API_KEY: null,
        SEARCH_URL: "https://search.example",
      }),
    ).toEqual(payload);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/mcp-api/services/service-1/environment");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/mcp-api/services/service-1/environment");
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("PUT");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      expectedRevision: 2,
      environment: { TAVILY_API_KEY: null, SEARCH_URL: "https://search.example" },
    });
  });

  it("covers service, Tool, and Prompt management mutations", async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: init?.method === "DELETE" ? 204 : 200,
        json: async () => ({ service: {}, version: {} }),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await updateService("service-1", 2, { name: "Reports" });
    await disableService("service-1", 3);
    await enableService("service-1", 4);
    await updateTool("service-1", "version-1", "tool-1", 5, { name: "search" });
    await deleteTool("service-1", "version-1", "tool-1", 6);
    await addPrompt("service-1", "version-1", 7, {
      name: "summary",
      arguments: [],
      messages: [{ role: "user", content: { type: "text", text: "Summarize" } }],
    });
    await updatePrompt("service-1", "version-1", "prompt-1", 8, { title: "Summary" });
    await deletePrompt("service-1", "version-1", "prompt-1", 9);
    await deleteService("service-1", 10);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/mcp-api/services/service-1",
      "/mcp-api/services/service-1/disable",
      "/mcp-api/services/service-1/enable",
      "/mcp-api/services/service-1/versions/version-1/tools/tool-1",
      "/mcp-api/services/service-1/versions/version-1/tools/tool-1",
      "/mcp-api/services/service-1/versions/version-1/prompts",
      "/mcp-api/services/service-1/versions/version-1/prompts/prompt-1",
      "/mcp-api/services/service-1/versions/version-1/prompts/prompt-1",
      "/mcp-api/services/service-1",
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual([
      "PATCH",
      "POST",
      "POST",
      "PATCH",
      "DELETE",
      "POST",
      "PATCH",
      "DELETE",
      "DELETE",
    ]);
  });

  it("covers builds, clients, API Keys, grants, and audit endpoints", async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: init?.method === "DELETE" ? 204 : 200,
        json: async () => ({
          builds: [],
          clients: [],
          client: {},
          keys: [],
          key: {},
          rawKey: "secret",
          grants: [],
          grant: {},
          events: [],
        }),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await listBuilds();
    await listClients();
    await createClient("Studio");
    await listApiKeys("client-1");
    await createApiKey("client-1", null);
    await revokeApiKey("client-1", "key-1");
    await listGrants("client-1");
    await upsertGrant("client-1", "service-1", {
      scopes: ["mcp:connect", "tools:list", "tools:call"],
      toolNames: ["echo"],
      promptNames: null,
    });
    await deleteGrant("client-1", "service-1");
    await listAuditEvents({ outcome: "FAILED", action: "service.publish" });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/mcp-api/builds?limit=100",
      "/mcp-api/clients",
      "/mcp-api/clients",
      "/mcp-api/clients/client-1/keys",
      "/mcp-api/clients/client-1/keys",
      "/mcp-api/clients/client-1/keys/key-1",
      "/mcp-api/clients/client-1/grants",
      "/mcp-api/clients/client-1/grants/service-1",
      "/mcp-api/clients/client-1/grants/service-1",
      "/mcp-api/audit?limit=100&outcome=FAILED&action=service.publish",
    ]);
  });

  it("loads the marketplace catalog and persists client quotas", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const payload = url.includes("/marketplace")
        ? {
            services: [
              {
                id: "service-1",
                name: "Remote Search",
                slug: "remote-search",
                type: "REMOTE_MCP",
                versionId: "version-1",
                versionNumber: 2,
                toolCount: null,
                promptCount: 0,
                toolsUnknown: true,
                tools: [],
                prompts: [],
              },
            ],
          }
        : url.includes("/quotas")
          ? {
              quotas: [],
              quota: {
                id: "quota-1",
                clientId: "client-1",
                serviceId: "service-1",
                qpsLimit: 5,
                dailyCallLimit: 1_000,
              },
            }
          : {
              events: [],
              summary: { total: 0, reserved: 0, succeeded: 0, failed: 0 },
            };
      return Promise.resolve({
        ok: true,
        status: init?.method === "PUT" ? 200 : 200,
        json: async () => payload,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(listMarketplaceServices()).resolves.toMatchObject([
      { slug: "remote-search", toolsUnknown: true, toolCount: null },
    ]);
    await listClientQuotas("client-1");
    await upsertClientQuota("client-1", {
      serviceId: "service-1",
      qpsLimit: 5,
      dailyCallLimit: 1_000,
    });
    await listClientUsage("client-1", { serviceId: "service-1", limit: 25 });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/mcp-api/marketplace?limit=100",
      "/mcp-api/clients/client-1/quotas",
      "/mcp-api/clients/client-1/quotas",
      "/mcp-api/clients/client-1/usage?limit=25&serviceId=service-1",
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      serviceId: "service-1",
      qpsLimit: 5,
      dailyCallLimit: 1_000,
    });
  });

  it("builds tool SLA queries for each window and optional service filter", () => {
    expect(buildToolSlaQuery()).toBe("window=24h");
    expect(buildToolSlaQuery({ window: "7d" })).toBe("window=7d");
    expect(buildToolSlaQuery({ window: "7d", serviceSlug: "remote-search" })).toBe(
      "window=7d&serviceSlug=remote-search",
    );
  });

  it("parses the tool SLA report and switches the requested window", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const window = new URL(`http://localhost${url}`).searchParams.get("window");
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          window,
          windowMinutes: 10080,
          generatedAt: "2026-07-31T12:00:00.000Z",
          serviceSlug: null,
          scan: { events: 3, limit: 200, truncated: false },
          totals: { calls: 3, succeeded: 2, failed: 1, successRate: 0.67, p95DurationMs: 400 },
          services: [
            {
              serviceSlug: "search",
              calls: 3,
              succeeded: 2,
              failed: 1,
              successRate: 0.67,
              p95DurationMs: 400,
              tools: [
                {
                  toolName: "query",
                  calls: 3,
                  succeeded: 2,
                  failed: 1,
                  successRate: 0.67,
                  p50DurationMs: 200,
                  p95DurationMs: 400,
                  maxDurationMs: 420,
                  errors: [{ code: "TOOL_ERROR", message: "fetch failed", count: 1 }],
                  lastFailure: {
                    code: "TOOL_ERROR",
                    message: "fetch failed",
                    statusCode: 200,
                    createdAt: "2026-07-31T11:30:00.000Z",
                  },
                },
              ],
            },
          ],
        }),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const report = await getToolSla({ window: "7d" });
    expect(report.window).toBe("7d");
    expect(report.services[0]?.tools[0]?.lastFailure?.message).toBe("fetch failed");
    expect(fetchMock).toHaveBeenCalledWith(
      "/mcp-api/observability/tools?window=7d",
      expect.any(Object),
    );
  });

  it("surfaces a readable error when the SLA request fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: { code: "INTERNAL_ERROR", message: "SLA unavailable" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getToolSla()).rejects.toBeInstanceOf(McpApiError);
    await expect(getToolSla()).rejects.toMatchObject({
      status: 500,
      code: "INTERNAL_ERROR",
      message: "SLA unavailable",
    });
  });
});
