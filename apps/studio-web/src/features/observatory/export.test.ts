import { afterEach, describe, expect, it, vi } from "vitest";
import {
  auditExportPath,
  downloadExport,
  filenameFromDisposition,
  triggerBlobDownload,
  usageExportPath,
} from "./export.js";

afterEach(() => vi.unstubAllGlobals());

describe("observatory export helpers", () => {
  it("builds the audit export query from the current filters without pagination", () => {
    const path = auditExportPath(
      {
        sourceId: "ops/source",
        actor: "operator-token:abc",
        entrypoint: "rerun",
        source: "rerun",
        sqlSource: "edited",
        status: "failed",
        from: "2026-10-01T00:00:00.000Z",
        to: "2026-10-31T23:59:59.999Z",
        search: "用户",
        limit: 20,
        offset: 40,
      },
      "csv",
    );
    const url = new URL(path, "http://localhost");
    expect(url.pathname).toBe("/api/observatory/audits/export");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      format: "csv",
      sourceId: "ops/source",
      actor: "operator-token:abc",
      entrypoint: "rerun",
      source: "rerun",
      sqlSource: "edited",
      status: "failed",
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-10-31T23:59:59.999Z",
      search: "用户",
    });
  });

  it("builds the usage export query with workspace scope and format", () => {
    const scoped = new URL(
      usageExportPath({ days: 30, all: true, kind: "chat" }, "json"),
      "http://localhost",
    );
    expect(scoped.pathname).toBe("/api/admin/usage/export");
    expect(Object.fromEntries(scoped.searchParams)).toEqual({
      format: "json",
      days: "30",
      workspaceId: "*",
      kind: "chat",
    });

    const plain = new URL(usageExportPath({ days: 7 }, "csv"), "http://localhost");
    expect(Object.fromEntries(plain.searchParams)).toEqual({ format: "csv", days: "7" });
  });

  it("parses the download filename from content-disposition and falls back when absent", () => {
    expect(
      filenameFromDisposition(
        'attachment; filename="query-audits-20261019-010203.csv"',
        "fallback.csv",
      ),
    ).toBe("query-audits-20261019-010203.csv");
    expect(filenameFromDisposition("attachment; filename=plain.json", "fallback.json")).toBe(
      "plain.json",
    );
    expect(
      filenameFromDisposition("attachment; filename*=UTF-8''%E5%AE%A1%E8%AE%A1.csv", "fallback"),
    ).toBe("审计.csv");
    expect(filenameFromDisposition(null, "fallback.csv")).toBe("fallback.csv");
    expect(filenameFromDisposition("attachment", "fallback.csv")).toBe("fallback.csv");
  });

  it("downloads the export as an authenticated blob and saves it with the resolved name", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(new Blob(["a,b\r\n1,2\r\n"], { type: "text/csv" }), {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": 'attachment; filename="query-audits-20261019-010203.csv"',
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const saved = vi.fn();
    const download = await downloadExport(
      "/api/observatory/audits/export?format=csv",
      "fallback.csv",
      saved,
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/observatory/audits/export?format=csv", undefined);
    expect(download.filename).toBe("query-audits-20261019-010203.csv");
    expect(saved).toHaveBeenCalledWith(download);
    await expect(download.blob.text()).resolves.toContain("1,2");
  });

  it("surfaces a readable error when the export request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "admin role is required" }), {
            status: 403,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    await expect(
      downloadExport("/api/admin/usage/export?format=csv", "fallback.csv", () => undefined),
    ).rejects.toThrow("admin role is required");
  });

  it("saves through an anchor element when no custom saver is provided", () => {
    const click = vi.fn();
    const remove = vi.fn();
    const append = vi.fn();
    const anchor = { href: "", download: "", rel: "", click, remove };
    vi.stubGlobal("document", {
      createElement: vi.fn(() => anchor),
      body: { append },
    });
    const createObjectURL = vi.fn(() => "blob:mock");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    triggerBlobDownload({ blob: new Blob(["x"]), filename: "usage-events-20261019-010203.csv" });
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(anchor.download).toBe("usage-events-20261019-010203.csv");
    expect(anchor.href).toBe("blob:mock");
    expect(append).toHaveBeenCalledWith(anchor);
    expect(click).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock");
  });
});
