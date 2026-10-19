import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONNECTOR_CREDENTIAL_FIELDS,
  fetchConnectorRuns,
  fetchConnectors,
  linesToPatterns,
  patternsToText,
  removeConnector,
  saveConnector,
  statusLabel,
  syncConnector,
  type ConnectorDraft,
} from "./api.js";
import { setStudioApiToken } from "../../lib/client.js";

afterEach(() => {
  vi.unstubAllGlobals();
  setStudioApiToken("");
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("connectors api", () => {
  it("lists connectors and attaches the studio token", async () => {
    setStudioApiToken("deploy-token");
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => jsonResponse({ connectors: [{ id: "c1", name: "HR", type: "http" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const connectors = await fetchConnectors();
    expect(connectors).toHaveLength(1);
    expect(connectors[0]?.name).toBe("HR");
    const [input, init] = fetchMock.mock.calls[0]!;
    expect(input).toBe("/api/admin/connectors");
    expect((init?.headers as Headers).get("authorization")).toBe("Bearer deploy-token");
  });

  it("creates a connector with a POST and omits blank credentials", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => jsonResponse({ connector: { id: "c1" } }, 201),
    );
    vi.stubGlobal("fetch", fetchMock);
    const draft: ConnectorDraft = {
      name: "通用源",
      type: "http",
      baseUrl: "https://example.com/docs",
      credentials: { token: "  " },
      filter: { include: ["hr/*"], exclude: [], maxDocuments: 50 },
      enabled: true,
    };
    await saveConnector(draft);
    const [input, init] = fetchMock.mock.calls[0]!;
    expect(input).toBe("/api/admin/connectors");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.name).toBe("通用源");
    expect(body.baseUrl).toBe("https://example.com/docs");
    expect("credentials" in body).toBe(false);
    expect(body.filter).toEqual({ include: ["hr/*"], exclude: [], maxDocuments: 50 });
  });

  it("updates a connector with a PUT and forwards filled credentials", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => jsonResponse({ connector: { id: "c9" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await saveConnector({
      id: "c9",
      name: "飞书",
      type: "feishu",
      baseUrl: "",
      credentials: { appId: "cli_x", appSecret: "secret" },
      filter: { include: [], exclude: [], maxDocuments: null },
      enabled: false,
    });
    const [input, init] = fetchMock.mock.calls[0]!;
    expect(input).toBe("/api/admin/connectors/c9");
    expect(init?.method).toBe("PUT");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.baseUrl).toBeNull();
    expect(body.credentials).toEqual({ appId: "cli_x", appSecret: "secret" });
    expect(body.enabled).toBe(false);
  });

  it("surfaces the server error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "type must be one of http" }, 400)),
    );
    await expect(
      saveConnector({
        name: "bad",
        type: "http",
        baseUrl: "",
        credentials: {},
        filter: { include: [], exclude: [], maxDocuments: null },
        enabled: true,
      }),
    ).rejects.toThrow("type must be one of http");
  });

  it("triggers a sync and reads the run history", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async (input) => {
        const url = String(input);
        if (url.endsWith("/sync")) {
          return jsonResponse({
            run: { id: "r1", status: "success", pulled: 3, ingested: 2, skipped: 1, failed: 0 },
            connector: { id: "c1" },
          });
        }
        return jsonResponse({
          runs: [{ id: "r1", status: "success", pulled: 3, ingested: 2, skipped: 1, failed: 0 }],
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const synced = await syncConnector("c1");
    expect(synced.run.ingested).toBe(2);
    const runs = await fetchConnectorRuns("c1", 5);
    expect(runs[0]?.skipped).toBe(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/admin/connectors/c1/sync");
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("/api/admin/connectors/c1/runs?limit=5");
  });

  it("deletes a connector with a 204 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    await expect(removeConnector("c1")).resolves.toBeUndefined();
  });
});

describe("connectors api helpers", () => {
  it("round-trips filter patterns through line text", () => {
    expect(linesToPatterns("hr/*\n\n  eng/*  ")).toEqual(["hr/*", "eng/*"]);
    expect(patternsToText(["hr/*", "eng/*"])).toBe("hr/*\neng/*");
  });

  it("labels sync statuses", () => {
    expect(statusLabel("success")).toBe("成功");
    expect(statusLabel("partial")).toBe("部分成功");
    expect(statusLabel("error")).toBe("失败");
    expect(statusLabel(null)).toBe("未同步");
  });

  it("exposes credential fields for the known connector types", () => {
    expect(CONNECTOR_CREDENTIAL_FIELDS.feishu.map((field) => field.key)).toEqual([
      "appId",
      "appSecret",
    ]);
    expect(CONNECTOR_CREDENTIAL_FIELDS["local-dir"]).toEqual([]);
  });
});
