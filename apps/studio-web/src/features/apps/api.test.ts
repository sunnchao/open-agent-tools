import { afterEach, describe, expect, it, vi } from "vitest";
import {
  employeeEntryPath,
  fetchPublishedApps,
  createPublishedApp,
  rotateAccessToken,
} from "./adminApi.js";
import { fetchAppProfile, resolveAppAccessToken, streamAppChat } from "./api.js";

function setUrl(search: string, hash = ""): void {
  (globalThis as { location?: { search: string; hash: string } }).location = { search, hash };
}

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.localStorage.clear();
  delete (globalThis as { location?: unknown }).location;
});

describe("published apps admin api", () => {
  it("lists apps through the studio client", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify({ apps: [{ id: "a1", slug: "hr" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchPublishedApps()).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/published-apps", undefined);
  });

  it("creates an app and builds the employee entry path", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify({ app: { id: "a1", slug: "hr" } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(createPublishedApp({ name: "HR" })).resolves.toMatchObject({ slug: "hr" });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ name: "HR" });
    expect(employeeEntryPath("hr")).toBe("#/app/hr");
  });
});

describe("employee app api", () => {
  it("delivers usage before completion, including the final usage snapshot", async () => {
    const usage = { requests: 2, inputTokens: 100, outputTokens: 20, totalTokens: 120, toolCalls: 1, toolErrors: 0 };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      `data: ${JSON.stringify({ usage: { ...usage, requests: 1 } })}\n\n` +
      `data: ${JSON.stringify({ done: true, usage })}\n\n`,
    )));
    const received: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      streamAppChat("hr", [{ role: "user", content: "hi" }], {
        onDelta: () => undefined,
        onUsage: (snapshot) => received.push(snapshot),
        onDone: resolve,
        onError: reject,
      });
    });
    expect(received).toEqual([{ ...usage, requests: 1 }, usage]);
  });

  it("loads the public profile without a token", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify({ app: { slug: "hr", name: "制度问答" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchAppProfile("hr")).resolves.toMatchObject({ name: "制度问答" });
    // 无口令时也统一走 (url, init) 形状（headers 为空对象）
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/apps/hr");
  });

  it("streams chat with only messages and sessionId", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('data: {"delta":"你好"}\n\n'));
              controller.enqueue(encoder.encode('data: {"done":true}\n\n'));
              controller.close();
            },
          }),
          { status: 200 },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const deltas: string[] = [];
    await new Promise<void>((resolve, reject) => {
      streamAppChat(
        "hr",
        [{ role: "user", content: "年假几天？" }],
        {
          onDelta: (delta) => deltas.push(delta),
          onDone: resolve,
          onError: reject,
        },
        { sessionId: "s1" },
      );
    });
    expect(deltas).toEqual(["你好"]);

    const init = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(init?.body));
    // 关键：员工侧不能传 resources / providerId / model
    expect(Object.keys(body).sort()).toEqual(["messages", "sessionId"]);
    expect(JSON.stringify(body)).not.toContain("viewerGroups");
  });
});

describe("app access token", () => {
  it("reads the token from the URL and persists it for later reloads", () => {
    setUrl("?access_token=abc123", "#/app/hr");
    expect(resolveAppAccessToken("hr")).toBe("abc123");
    // 再次读取（模拟刷新，URL 已不带 token）仍能取到
    setUrl("", "#/app/hr");
    expect(resolveAppAccessToken("hr")).toBe("abc123");
  });

  it("sends the token header on profile and chat requests", async () => {
    setUrl("?access_token=secret-token");
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Promise.resolve(
        _url.includes("/chat")
          ? new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(encoder.encode('data: {"done":true}\n\n'));
                  controller.close();
                },
              }),
              { status: 200 },
            )
          : new Response(JSON.stringify({ app: { slug: "hr", name: "HR" } }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchAppProfile("hr");
    const profileHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(profileHeaders["x-app-access-token"]).toBe("secret-token");

    await new Promise<void>((resolve, reject) => {
      streamAppChat("hr", [{ role: "user", content: "hi" }], {
        onDelta: () => undefined,
        onDone: resolve,
        onError: reject,
      });
    });
    const chatHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(chatHeaders["x-app-access-token"]).toBe("secret-token");
  });

  it("builds an entry link carrying the token", () => {
    expect(employeeEntryPath("hr", "tok")).toBe("#/app/hr?access_token=tok");
    expect(employeeEntryPath("hr")).toBe("#/app/hr");
  });

  it("rotates an access token through the admin endpoint", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Promise.resolve(
        new Response(
          JSON.stringify({ app: { id: "a1", accessMode: "token" }, token: "new-token" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(rotateAccessToken("a1", true)).resolves.toMatchObject({ token: "new-token" });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({ enable: true });
  });
});
