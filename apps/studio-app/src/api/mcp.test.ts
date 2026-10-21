import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildToolSlaQuery,
  callGatewayTool,
  createService,
  getToolSla,
  listAuditEvents,
  listServices,
  listVersions,
  McpApiError,
  publishVersion,
} from "./mcp";
import { setAuthMemory, __resetAuth } from "../lib/http";
import { setStorageBackend } from "../lib/storage";

describe("mcp api", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetAuth();
    setStorageBackend({
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async () => {},
    });
  });
  it("lists services and versions through the control-plane prefix", async () => {
    setAuthMemory({ mcpUrl: "http://mcp:4200" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ services: [{ id: "s" }] }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ versions: [] }) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ service: {}, version: {} }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ events: [] }) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ window: "7d", totals: {} }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ events: [] }) });
    vi.stubGlobal("fetch", fetchMock);
    expect((await listServices())[0]?.id).toBe("s");
    expect(await listVersions("s")).toEqual([]);
    await createService({ name: "n", slug: "s" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await publishVersion("s", "v", 1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://mcp:4200/api/admin/mcp/services");
    await listAuditEvents({ outcome: "FAILED" });
    await getToolSla({ window: "7d" });
    expect(buildToolSlaQuery({ serviceSlug: "demo" })).toContain("serviceSlug=demo");
  });
  it("throws McpApiError with code", async () => {
    setAuthMemory({ mcpUrl: "http://mcp:4200" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ error: { code: "NOT_FOUND", message: "nope" } }),
      }),
    );
    await expect(listServices()).rejects.toMatchObject({ status: 404 });
    try {
      await listServices();
    } catch (e) {
      expect((e as McpApiError).code).toBe("NOT_FOUND");
    }
  });
  it("calls gateway tools via plain JSON-RPC", async () => {
    setAuthMemory({ gatewayUrl: "http://gw:4100" });
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ result: { ok: 1 } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(
      await callGatewayTool({ serviceSlug: "demo", apiKey: "k", toolName: "echo", arguments: {} }),
    ).toEqual({ ok: 1 });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://gw:4100/mcp/services/demo");
    await expect(
      callGatewayTool({ serviceSlug: "demo", apiKey: " ", toolName: "echo", arguments: {} }),
    ).rejects.toThrow("API Key");
  });
});
