import { afterEach, describe, expect, it, vi } from "vitest";
import { agentFetch, getSettings, mcpFetch, setAuthMemory, __resetAuth } from "./http";
import { setStorageBackend } from "./storage";

describe("http auth", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetAuth();
    setStorageBackend(null);
  });
  it("agentFetch carries token and workspace", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    setStorageBackend({
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async () => {},
    });
    setAuthMemory({
      token: "tok",
      workspaceId: "ws",
      agentUrl: "http://agent:3000",
      mcpUrl: "http://mcp:4200",
      gatewayUrl: "http://gw:4100",
    });
    await agentFetch("/api/sessions");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://agent:3000/api/sessions");
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer tok");
    expect(headers.get("x-workspace-id")).toBe("ws");
  });
  it("mcpFetch prefixes the control-plane path", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetchMock);
    setStorageBackend({
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async () => {},
    });
    setAuthMemory({
      agentUrl: "http://agent:3000",
      mcpUrl: "http://mcp:4200/",
      gatewayUrl: "http://gw:4100",
    });
    await mcpFetch("/services", { method: "POST", body: JSON.stringify({}) });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://mcp:4200/api/admin/mcp/services");
    const s = await getSettings();
    expect(s.mcpUrl).toBe("http://mcp:4200");
  });
});
