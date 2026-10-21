import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchConnectors,
  saveConnector,
  linesToPatterns,
  statusLabel,
  listReports,
  createReport,
  fetchProviders,
  saveProvider,
  fetchImChannels,
  saveImChannel,
  fetchResourceCatalog,
  fetchBranding,
  saveBranding,
  fetchMcpGatewayConfig,
  saveMcpGatewayConfig,
  fetchWorkspaces,
  fetchUsage,
  fetchPublishedApps,
  createPublishedApp,
  fetchPublishedAppIdentity,
  fetchIdentityStatus,
  IDENTITY_PROVIDER_LABELS,
  LDAP_READINESS_LABELS,
} from "./misc";
import { setAuthMemory, __resetAuth } from "../lib/http";
import { setStorageBackend } from "../lib/storage";

describe("misc apis", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetAuth();
    setStorageBackend({
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async () => {},
    });
  });
  it("covers connectors/reports/providers/im/resources/branding/gateway/workspaces/apps", async () => {
    setAuthMemory({ agentUrl: "http://a:3000" });
    const fetchMock = vi.fn();
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    fetchMock
      .mockResolvedValueOnce(ok({ connectors: [] }))
      .mockResolvedValueOnce(ok({ connector: { id: "c" } }))
      .mockResolvedValueOnce(ok({ reports: [] }))
      .mockResolvedValueOnce(ok({ report: { id: "r" } }))
      .mockResolvedValueOnce(ok({ providers: [] }))
      .mockResolvedValueOnce(ok({ provider: { id: "p" } }))
      .mockResolvedValueOnce(ok({ channels: [] }))
      .mockResolvedValueOnce(ok({ channel: { id: "i" } }))
      .mockResolvedValueOnce(ok({ mcp: { services: [] }, rag: { sources: [] } }))
      .mockResolvedValueOnce(ok({ branding: { productName: "x" } }))
      .mockResolvedValueOnce(ok({ branding: { productName: "y" } }))
      .mockResolvedValueOnce(ok({ config: { configured: false } }))
      .mockResolvedValueOnce(ok({ config: { configured: true } }))
      .mockResolvedValueOnce(ok({ workspaces: [] }))
      .mockResolvedValueOnce(ok({ usage: { totals: {} } }))
      .mockResolvedValueOnce(ok({ apps: [] }))
      .mockResolvedValueOnce(ok({ app: { id: "a" } }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchConnectors()).toEqual([]);
    expect(
      (
        await saveConnector({
          name: "n",
          type: "http",
          baseUrl: "",
          credentials: { token: " " },
          filter: { include: [], exclude: [], maxDocuments: null },
          enabled: true,
        })
      ).id,
    ).toBe("c");
    expect((await listReports()).reports).toEqual([]);
    expect(
      (
        await createReport({
          name: "n",
          question: "q",
          sourceId: null,
          frequency: "daily",
          time: "08:00",
          weekday: 1,
          enabled: true,
        })
      ).report.id,
    ).toBe("r");
    expect(await fetchProviders()).toEqual([]);
    expect(
      (await saveProvider({ name: "n", baseUrl: "http://x", models: ["m"], enabled: true })).id,
    ).toBe("p");
    expect(await fetchImChannels()).toEqual([]);
    expect(
      (
        await saveImChannel({
          name: "n",
          platform: "feishu",
          appId: "a",
          ragSources: [],
          ragTopK: 5,
          requireMention: true,
          enabled: true,
        })
      ).id,
    ).toBe("i");
    expect((await fetchResourceCatalog()).rag.sources).toEqual([]);
    expect((await fetchBranding()).productName).toBe("x");
    expect(
      (
        await saveBranding({
          productName: "y",
          shortName: "s",
          markText: "m",
          logoUrl: null,
          primaryColor: "#fff",
          accentColor: "#000",
          supportUrl: null,
          footerText: "",
          partnerCode: null,
          hideVendorBrand: false,
        })
      ).productName,
    ).toBe("y");
    expect((await fetchMcpGatewayConfig()).configured).toBe(false);
    expect((await saveMcpGatewayConfig({ gatewayUrl: "http://g" })).configured).toBe(true);
    expect(await fetchWorkspaces()).toEqual([]);
    expect((await fetchUsage()).totals).toEqual({});
    expect(await fetchPublishedApps()).toEqual([]);
    expect((await createPublishedApp({ name: "n" })).id).toBe("a");
    expect(linesToPatterns("a\n\na")).toEqual(["a"]);
    expect(statusLabel("success")).toBe("成功");
    expect(fetchMock).toHaveBeenCalledTimes(17);
  });
  it("fetches published-app identity and enterprise identity status", async () => {
    setAuthMemory({ agentUrl: "http://a:3000" });
    const fetchMock = vi.fn();
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    fetchMock
      .mockResolvedValueOnce(ok({ identity: { enabled: true, identityMode: "required" } }))
      .mockResolvedValueOnce(
        ok({
          identity: {
            enabled: true,
            provider: "oidc",
            mode: "oidc",
            issuer: "https://id.example",
            audience: "studio",
            groupsClaim: "groups",
            rolesClaim: "roles",
            adminRoles: ["admin"],
            ldap: { readiness: "ready", summary: "ok" },
            deploymentTokenFallback: false,
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    expect((await fetchPublishedAppIdentity()).identityMode).toBe("required");
    const st = await fetchIdentityStatus();
    expect(st.provider).toBe("oidc");
    expect(IDENTITY_PROVIDER_LABELS[st.provider]).toBe("OIDC");
    expect(LDAP_READINESS_LABELS[st.ldap.readiness]).toBe("网关链路就绪");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://a:3000/api/admin/published-apps/identity");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://a:3000/api/admin/identity/status");
  });

  it("rejects resource catalog requests that exceed the client timeout", async () => {
    vi.useFakeTimers();
    setAuthMemory({ agentUrl: "http://a:3000" });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      ),
    );

    const assertion = expect(fetchResourceCatalog()).rejects.toThrow("资源目录加载超时");
    await vi.advanceTimersByTimeAsync(12000);
    await assertion;
    vi.useRealTimers();
  });
});
