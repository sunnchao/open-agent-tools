import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspace, fetchUsage, fetchWorkspaces } from "./api.js";
import { getWorkspaceId, setWorkspaceId, studioFetch } from "../../lib/client.js";

afterEach(() => {
  vi.unstubAllGlobals();
  setWorkspaceId("");
  globalThis.localStorage.removeItem("open-agent-tools.studio-api-token");
});

describe("workspace api", () => {
  it("lists workspaces", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify({ workspaces: [{ id: "default", name: "默认空间" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchWorkspaces()).resolves.toEqual([{ id: "default", name: "默认空间" }]);
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/workspaces", undefined);
  });

  it("creates a workspace with a JSON body", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify({ workspace: { id: "w1", name: "交付部" } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(createWorkspace({ name: "交付部" })).resolves.toMatchObject({ id: "w1" });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ name: "交付部" });
  });

  it("requests the global usage view with workspaceId=*", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify({ usage: { workspaceId: "*", totals: {} } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await fetchUsage({ days: 7, all: true });
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/api/admin/usage?");
    expect(url).toContain("days=7");
    expect(url).toContain("workspaceId=*");
  });
});

describe("studioFetch workspace header", () => {
  it("adds the workspace header only for studio api calls", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response("{}", { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    setWorkspaceId("w-team");
    expect(getWorkspaceId()).toBe("w-team");

    await studioFetch("/api/sessions");
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("x-workspace-id")).toBe("w-team");

    // 非 Studio 通道不应带上主服务的 workspace 头
    await studioFetch("/mcp-api/services");
    const mcpHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Headers | undefined;
    expect(mcpHeaders?.get("x-workspace-id") ?? null).toBeNull();
  });

  it("passes through unchanged when neither token nor workspace is configured", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response("{}", { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    setWorkspaceId("");
    await studioFetch("/api/sessions");
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions", undefined);
  });
});
