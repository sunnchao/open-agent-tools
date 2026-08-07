import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchProviders,
  fetchProviderModels,
  probeProviderModels,
  saveProvider,
  setDefaultProvider,
} from "./api.js";

afterEach(() => vi.unstubAllGlobals());

describe("provider api", () => {
  it("loads admin metadata without exposing a key", async () => {
    const fetchMock = vi.fn(
      async (_url: string) =>
        new Response(
          JSON.stringify({
            providers: [
              {
                id: "default",
                name: "OpenAI",
                baseUrl: "https://example.com/v1",
                models: ["m"],
                enabled: true,
                isDefault: true,
                apiKeyMasked: "sk***abc",
                format: "openai-chat",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchProviders({ includeDisabled: true })).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/providers");
  });

  it("saves and fetches model suggestions", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes("fetch-models"))
        return new Response(JSON.stringify({ models: ["a", "b"] }), { status: 200 });
      return new Response(
        JSON.stringify({
          provider: {
            id: "p1",
            name: "Test",
            baseUrl: "https://example.com/v1",
            models: ["a"],
            enabled: true,
            isDefault: false,
            apiKeyMasked: null,
          },
        }),
        { status: 201 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      saveProvider({
        name: "Test",
        baseUrl: "https://example.com/v1",
        apiKey: "secret",
        models: ["a"],
        enabled: true,
      }),
    ).resolves.toMatchObject({ id: "p1" });
    await expect(fetchProviderModels("p1")).resolves.toEqual(["a", "b"]);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
  });

  it("probes models by params for a new provider", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ models: ["x", "y"] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      probeProviderModels({ baseUrl: "https://example.com/v1", apiKey: "sk-x" }),
    ).resolves.toEqual(["x", "y"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/providers/fetch-models",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ baseUrl: "https://example.com/v1", apiKey: "sk-x" }),
      }),
    );
  });

  it("sets the selected provider as default", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ provider: { id: "provider/id", isDefault: true } }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(setDefaultProvider("provider/id")).resolves.toMatchObject({ isDefault: true });
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/providers/provider%2Fid/default", {
      method: "PUT",
    });
  });
});
