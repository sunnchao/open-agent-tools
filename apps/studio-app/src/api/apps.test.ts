import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchAppProfile,
  resolveAppAccessToken,
  saveAppAccessToken,
  streamAppChat,
} from "./apps";
import { setAuthMemory, __resetAuth } from "../lib/http";
import { setStorageBackend, __resetMemory } from "../lib/storage";

describe("published app chat", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetAuth();
    __resetMemory();
  });
  it("persists access tokens in storage", async () => {
    __resetMemory();
    setStorageBackend({
      getItem: async (k: string) =>
        (await import("../lib/storage").then((m) => m.syncMemoryStorage.getItem(k))) as
          string | null,
      setItem: async (k: string, v: string) => {
        await import("../lib/storage").then((m) => m.syncMemoryStorage.setItem(k, v));
      },
      removeItem: async (k: string) => {
        await import("../lib/storage").then((m) => m.syncMemoryStorage.removeItem(k));
      },
    });
    await saveAppAccessToken("hr", "tok");
    expect(await resolveAppAccessToken("hr")).toBe("tok");
  });
  it("fetches profile and streams chat", async () => {
    setAuthMemory({ agentUrl: "http://a:3000" });
    setStorageBackend({
      getItem: async () => "tok",
      setItem: async () => {},
      removeItem: async () => {},
    });
    const text = 'data: {"delta":"hi"}\n\ndata: {"done":true}\n\n';
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ app: { slug: "hr" } }) })
      .mockResolvedValueOnce({ ok: true, body: stream });
    vi.stubGlobal("fetch", fetchMock);
    expect((await fetchAppProfile("hr")).slug).toBe("hr");
    const deltas: string[] = [];
    let done = false;
    streamAppChat("hr", [{ role: "user", content: "hi" }], {
      onDelta: (d) => deltas.push(d),
      onDone: () => {
        done = true;
      },
      onError: () => {
        throw new Error("no");
      },
    });
    await vi.waitFor(() => expect(done).toBe(true));
    expect(deltas).toEqual(["hi"]);
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Headers).get?.("x-app-access-token")).toBe(
      "tok",
    );
  });
});
