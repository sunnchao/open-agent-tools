import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addPrompt,
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
  updateTool,
  upsertGrant,
  uploadArtifact,
  validateVersion,
} from "./api.js";

describe("MCP Studio API", () => {
  afterEach(() => vi.unstubAllGlobals());

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
});
