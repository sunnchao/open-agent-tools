import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  DINGTALK_BOT_MESSAGE_TOPIC,
  DingTalkStreamClient,
  type WebSocketLike,
} from "./streamClient.js";

const GATEWAY_URL = "https://api.dingtalk.com/v1.0/gateway/connections/open";

/** 极简假 WebSocket：手动触发 open/message/close，记录 send 内容。 */
class FakeWebSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: string[] = [];
  closeCalls = 0;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls += 1;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  emitPush(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  sentJson(): Array<Record<string, unknown>> {
    return this.sent.map((item) => JSON.parse(item) as Record<string, unknown>);
  }
}

function gatewayResponse(): Response {
  return new Response(
    JSON.stringify({ endpoint: "wss://stream.example.com/connect", ticket: "tk_1" }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

function makeClient(options?: {
  fetchImpl?: typeof fetch;
  sockets?: FakeWebSocket[];
  onMessage?: (data: unknown) => void | Promise<void>;
  baseDelay?: number;
}) {
  const sockets = options?.sockets ?? [];
  const client = new DingTalkStreamClient({
    clientId: "client_1",
    clientSecret: "secret_1",
    ua: "test-ua",
    ...(options?.onMessage ? { onMessage: options.onMessage } : {}),
    fetchImpl: options?.fetchImpl ?? (async () => gatewayResponse()),
    webSocketFactory: (url: string) => {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket;
    },
    reconnectBaseDelayMs: options?.baseDelay ?? 1,
    reconnectMaxDelayMs: 10,
    random: () => 0.5,
  });
  return { client, sockets };
}

describe("DingTalkStreamClient", () => {
  it("opens the gateway with the bot message subscription and connects with ticket", async () => {
    const fetchMock = mock.fn(
      async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> =>
        gatewayResponse(),
    );
    const { client, sockets } = makeClient({ fetchImpl: fetchMock as unknown as typeof fetch });
    const connectPromise = client.connect();
    // 等待 fetch 与 factory 执行，再手动 open。
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sockets.length, 1);
    sockets[0]!.open();
    await connectPromise;

    assert.equal(fetchMock.mock.calls.length, 1);
    const [url, init] = fetchMock.mock.calls[0]!.arguments;
    assert.equal(url, GATEWAY_URL);
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      clientId: "client_1",
      clientSecret: "secret_1",
      ua: "test-ua",
      subscriptions: [{ type: "CALLBACK", topic: DINGTALK_BOT_MESSAGE_TOPIC }],
    });
    assert.equal(sockets[0]!.url, "wss://stream.example.com/connect?ticket=tk_1");
    assert.equal(client.isConnected(), true);
    client.disconnect();
  });

  it("replies ping with the original data payload and matching messageId", async () => {
    const { client, sockets } = makeClient();
    const connectPromise = client.connect();
    await new Promise((resolve) => setImmediate(resolve));
    sockets[0]!.open();
    await connectPromise;

    const pingData = JSON.stringify({ opaque: "opaque-123" });
    sockets[0]!.emitPush({
      type: "SYSTEM",
      headers: { topic: "ping", messageId: "mid_ping", contentType: "application/json" },
      data: pingData,
    });

    assert.deepEqual(sockets[0]!.sentJson(), [
      {
        code: 200,
        headers: { contentType: "application/json", messageId: "mid_ping" },
        message: "OK",
        data: pingData,
      },
    ]);
    client.disconnect();
  });

  it("ACKs CALLBACK immediately, before the async handler resolves", async () => {
    let releaseHandler: (() => void) | undefined;
    const handlerCalled = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const { client, sockets } = makeClient({
      onMessage: () => handlerCalled, // 模拟长时间 LLM 处理
    });
    const connectPromise = client.connect();
    await new Promise((resolve) => setImmediate(resolve));
    sockets[0]!.open();
    await connectPromise;

    sockets[0]!.emitPush({
      type: "CALLBACK",
      headers: { topic: DINGTALK_BOT_MESSAGE_TOPIC, messageId: "mid_cb" },
      data: JSON.stringify({ msgId: "m1", text: { content: "hi" } }),
    });

    // handler 尚未完成，但 ACK 已经发出。
    assert.deepEqual(sockets[0]!.sentJson(), [
      {
        code: 200,
        headers: { contentType: "application/json", messageId: "mid_cb" },
        message: "OK",
        data: JSON.stringify({ response: null }),
      },
    ]);
    releaseHandler?.();
    client.disconnect();
  });

  it("dispatches parsed CALLBACK data to the handler", async () => {
    const received: unknown[] = [];
    const { client, sockets } = makeClient({
      onMessage: (data) => {
        received.push(data);
      },
    });
    const connectPromise = client.connect();
    await new Promise((resolve) => setImmediate(resolve));
    sockets[0]!.open();
    await connectPromise;

    const payload = { msgId: "m2", conversationId: "cid", msgtype: "text" };
    sockets[0]!.emitPush({
      type: "CALLBACK",
      headers: { topic: DINGTALK_BOT_MESSAGE_TOPIC, messageId: "mid_cb2" },
      data: JSON.stringify(payload),
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(received, [payload]);
    client.disconnect();
  });

  it("routes disconnect through ACK + close", async () => {
    const { client, sockets } = makeClient();
    const connectPromise = client.connect();
    await new Promise((resolve) => setImmediate(resolve));
    sockets[0]!.open();
    await connectPromise;

    sockets[0]!.emitPush({
      type: "SYSTEM",
      headers: { topic: "disconnect", messageId: "mid_dc" },
      data: JSON.stringify({ reason: "connection is expired" }),
    });
    assert.equal(sockets[0]!.sentJson()[0]!.code, 200);
    assert.equal(sockets[0]!.closeCalls, 1);
    client.disconnect();
  });

  it("stops reconnecting after disconnect()", async () => {
    const { client, sockets } = makeClient({ baseDelay: 5 });
    const connectPromise = client.connect();
    await new Promise((resolve) => setImmediate(resolve));
    sockets[0]!.open();
    await connectPromise;

    // 模拟服务端断开 → 应排重连。
    sockets[0]!.readyState = 3;
    sockets[0]!.onclose?.({ code: 1006, reason: "abnormal" });
    client.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(sockets.length, 1, "no new socket after disconnect");
    assert.equal(client.isConnected(), false);
  });

  it("reconnects with backoff after an unexpected close", async () => {
    const { client, sockets } = makeClient({ baseDelay: 2 });
    const connectPromise = client.connect();
    await new Promise((resolve) => setImmediate(resolve));
    sockets[0]!.open();
    await connectPromise;

    sockets[0]!.readyState = 3;
    sockets[0]!.onclose?.({ code: 1006, reason: "abnormal" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(sockets.length, 2, "a new socket should be created");
    sockets[1]!.open();
    assert.equal(client.isConnected(), true);
    client.disconnect();
  });

  it("reports readable errors for gateway HTTP failures", async () => {
    const { client } = makeClient({
      fetchImpl: (async () =>
        new Response("bad clientSecret", { status: 400 })) as unknown as typeof fetch,
    });
    await assert.rejects(
      client.connect(),
      /dingtalk gateway open failed \(HTTP 400\): bad clientSecret/,
    );
    client.disconnect();
  });

  it("keeps retrying after the initial connect failure", async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("network down");
      return gatewayResponse();
    }) as unknown as typeof fetch;
    const { client, sockets } = makeClient({ fetchImpl, baseDelay: 2 });
    await assert.rejects(client.connect(), /dingtalk gateway open failed: network down/);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(sockets.length >= 1, "reconnect should have opened a socket");
    sockets[sockets.length - 1]!.open();
    assert.equal(client.isConnected(), true);
    client.disconnect();
  });
});
