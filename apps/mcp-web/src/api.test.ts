import { afterEach, describe, expect, it, vi } from "vitest";

import { McpApiClient } from "./api.js";

describe("MCP Admin API client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("WEB-004 and WEB-005 persist Tool and Prompt edits with optimistic revisions", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ version: {} }) });
    vi.stubGlobal("fetch", fetchMock);
    const api = new McpApiClient();

    await api.addTool("service-1", "version-1", 3, {
      name: "get_report",
      handler: "getReport",
      inputSchema: { type: "object" },
    });
    await api.addPrompt("service-1", "version-1", 4, {
      name: "summarize_report",
      arguments: [],
      messages: [{ role: "user", content: { type: "text", text: "Summarize this." } }],
    });

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        expectedRevision: 3,
        tool: {
          name: "get_report",
          handler: "getReport",
          inputSchema: { type: "object" },
        },
      }),
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty("authorization");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      body: expect.stringContaining('"expectedRevision":4'),
    });
  });

  it("WEB-007 performs direct ZIP upload before confirming the artifact", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          objectKey: "service-1/version-1/archive.zip",
          upload: {
            url: "https://objects.example/upload",
            method: "PUT",
            headers: {
              "content-type": "application/zip",
              "content-length": "9",
              "x-amz-checksum-sha256": "checksum",
              "x-amz-meta-sha256": "sha256:digest",
            },
          },
        }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({
        ok: true,
        status: 202,
        json: async () => ({ version: { status: "VALIDATING" }, job: { id: "job-1" } }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const api = new McpApiClient();
    const file = new File(["zip-bytes"], "tools.zip", { type: "application/zip" });

    await api.uploadArtifact("service-1", "version-1", 2, file);

    expect(fetchMock.mock.calls[0]?.[0]).toContain("/upload-url");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://objects.example/upload");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "PUT",
      body: file,
      headers: {
        "content-type": "application/zip",
        "content-length": "9",
        "x-amz-checksum-sha256": "checksum",
        "x-amz-meta-sha256": "sha256:digest",
      },
    });
    expect(fetchMock.mock.calls[2]?.[0]).toContain("/complete-upload");
  });

  it("WEB-009 and WEB-010 send optimistic revisions for rollback and disable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ service: { status: "DISABLED" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ service: {}, version: { status: "PUBLISHED" } }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const api = new McpApiClient();

    await api.disableService("service-1", 7);
    await api.rollbackVersion("service-1", "version-1", 11);

    expect(fetchMock.mock.calls[0]).toEqual([
      "/api/admin/mcp/services/service-1/disable",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ expectedRevision: 7 }) }),
    ]);
    expect(fetchMock.mock.calls[1]).toEqual([
      "/api/admin/mcp/services/service-1/versions/version-1/rollback",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ expectedRevision: 11 }) }),
    ]);
  });

  it("queries Builds and Audit and persists Client access configuration", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ builds: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ client: { id: "client-1" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ key: { id: "key-1" }, rawKey: "mcp.secret" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ grant: { id: "grant-1" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ events: [] }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const api = new McpApiClient();

    await api.listBuilds();
    await api.createClient("Reporting client");
    await api.createApiKey("client-1", "2026-09-01T00:00:00.000Z");
    await api.upsertGrant("client-1", "service-1", {
      scopes: ["mcp:connect", "tools:list", "tools:call"],
      toolNames: ["tool_a", "tool_b"],
      promptNames: [],
    });
    await api.listAuditEvents({ outcome: "FAILED", action: "POST /services" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/admin/mcp/builds?limit=100");
    expect(fetchMock.mock.calls[1]).toEqual([
      "/api/admin/mcp/clients",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "Reporting client" }),
      }),
    ]);
    expect(fetchMock.mock.calls[2]).toEqual([
      "/api/admin/mcp/clients/client-1/keys",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ expiresAt: "2026-09-01T00:00:00.000Z" }),
      }),
    ]);
    expect(fetchMock.mock.calls[3]).toEqual([
      "/api/admin/mcp/clients/client-1/grants/service-1",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          scopes: ["mcp:connect", "tools:list", "tools:call"],
          toolNames: ["tool_a", "tool_b"],
          promptNames: [],
        }),
      }),
    ]);
    expect(fetchMock.mock.calls[4]?.[0]).toBe(
      "/api/admin/mcp/audit?limit=100&outcome=FAILED&action=POST+%2Fservices",
    );
  });
});
