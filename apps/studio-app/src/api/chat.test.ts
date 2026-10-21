import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSessionApi,
  deleteMessageApi,
  deleteSessionApi,
  fetchSessions,
  renameSessionApi,
  streamChat,
} from "./chat";
import { setAuthMemory, __resetAuth } from "../lib/http";
import { setStorageBackend } from "../lib/storage";

function stubFetchSequence(
  bodies: Array<{ ok: boolean; status?: number; json?: () => Promise<unknown> }>,
) {
  const fetchMock = vi.fn();
  bodies.forEach((b) => fetchMock.mockResolvedValueOnce(b));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("chat sessions api", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetAuth();
    setStorageBackend({
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async () => {},
    });
  });
  it("fetches and mutates sessions with auth prefix", async () => {
    setAuthMemory({ agentUrl: "http://agent:3000" });
    const fetchMock = stubFetchSequence([
      { ok: true, json: async () => ({ sessions: [{ id: "s1" }] }) },
      { ok: true, json: async () => ({ session: { id: "s2" } }) },
      { ok: true, json: async () => ({ session: { id: "s1", title: "t" } }) },
      { ok: true },
      { ok: false, status: 404 },
    ]);
    expect(await fetchSessions()).toEqual([{ id: "s1" }]);
    expect((await createSessionApi()).id).toBe("s2");
    expect((await renameSessionApi("s1", "t")).title).toBe("t");
    await deleteSessionApi("s1");
    await deleteMessageApi("missing");
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://agent:3000/api/sessions");
  });
  it("streams chat deltas until done", async () => {
    setAuthMemory({ agentUrl: "http://agent:3000" });
    const text =
      'data: {"assistantMessageId":"a1"}\n\ndata: {"delta":"hi"}\n\ndata: {"done":true,"usage":{"inputTokens":1,"outputTokens":2,"totalTokens":3,"toolCalls":0,"toolErrors":0}}\n\n';
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, body: stream }));
    const deltas: string[] = [];
    let done: unknown;
    let assistantId = "";
    streamChat(
      [{ role: "user", content: "hi" }],
      undefined,
      {
        onDelta: (d) => deltas.push(d),
        onDone: (m) => {
          done = m;
        },
        onError: () => {
          throw new Error("should not error");
        },
        onAssistantMessageId: (id) => {
          assistantId = id;
        },
      },
      { sessionId: "s1" },
    );
    await vi.waitFor(() => expect(done).toBeDefined());
    expect(deltas).toEqual(["hi"]);
    expect(assistantId).toBe("a1");
    expect(done).toMatchObject({ assistantMessageId: "a1" });
  });
  it("surfaces http errors", async () => {
    setAuthMemory({ agentUrl: "http://agent:3000" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: "bad" }) }),
    );
    let err = "";
    streamChat([{ role: "user", content: "hi" }], undefined, {
      onDelta: () => {},
      onDone: () => {},
      onError: (e) => {
        err = e;
      },
    });
    await vi.waitFor(() => expect(err).toBe("bad"));
  });
});
