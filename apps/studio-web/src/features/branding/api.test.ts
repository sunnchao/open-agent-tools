import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BRANDING,
  fetchBranding,
  fetchPublicBranding,
  resetBranding,
  saveBranding,
} from "./api.js";

describe("branding API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the public branding endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ branding: { ...DEFAULT_BRANDING, partnerCode: "p-1" } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const branding = await fetchPublicBranding();
    expect(fetchMock).toHaveBeenCalledWith("/api/branding", undefined);
    expect(branding.partnerCode).toBe("p-1");
  });

  it("reads the admin branding endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ branding: DEFAULT_BRANDING }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await fetchBranding();
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/branding", undefined);
  });

  it("puts the full configuration on save", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ branding: DEFAULT_BRANDING }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await saveBranding({ ...DEFAULT_BRANDING, productName: "新品牌" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/admin/branding");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body)).productName).toBe("新品牌");
  });

  it("surfaces server errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: "primaryColor 必须是 #RRGGBB 颜色" }),
      }),
    );
    await expect(saveBranding(DEFAULT_BRANDING)).rejects.toThrow("#RRGGBB");
  });

  it("deletes to reset", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ branding: DEFAULT_BRANDING }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await resetBranding();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("DELETE");
  });
});
