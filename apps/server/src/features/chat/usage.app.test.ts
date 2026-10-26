import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createApp } from "../../app.js";
import { closeDb } from "../../platform/db.js";
import { createProvider, setDefaultProvider } from "../providers/store.js";
import { summarizeUsage } from "../../platform/usage/events.js";

let server: Server;
let origin: string;
let dir: string;
let originalFetch: typeof globalThis.fetch;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "chat-usage-test-"));
  process.env.NODE_ENV = "test";
  process.env.SQLITE_PATH = join(dir, "test.sqlite");
  process.env.CONFIG_SECRETS_ENCRYPTION_KEY =
    "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
  delete process.env.STUDIO_API_TOKEN;
  createProvider({
    id: "default",
    name: "OpenAI",
    baseUrl: "http://127.0.0.1:9/v1",
    models: ["gpt-4o-mini"],
    enabled: true,
    apiKey: "test-key",
  });
  setDefaultProvider("default");

  // 拦截 OpenAI 流式响应：一段内容 + usage 统计 + [DONE]。
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).includes("/chat/completions")) return originalFetch(input, init);
    const encoder = new TextEncoder();
    const chunks = [
      'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\n',
      'data: {"id":"x","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20}}\n\n',
      "data: [DONE]\n\n",
    ];
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch;

  server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  globalThis.fetch = originalFetch;
  server.close();
  await once(server, "close");
  closeDb();
  delete process.env.SQLITE_PATH;
  delete process.env.CONFIG_SECRETS_ENCRYPTION_KEY;
  rmSync(dir, { recursive: true, force: true });
});

describe("chat usage metering", () => {
  it("streams usage and records a chat usage event after the turn", async () => {
    const response = await fetch(`${origin}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hi" }],
        sessionId: "session-usage",
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    // P0-4：token 用量必须透出，且终局事件带上累计值。
    assert.match(body, /"usage":\{[^}]*"totalTokens":120/);
    assert.match(body, /"done":true[^}]*"usage":/);

    const summary = summarizeUsage(Date.now() - 60_000, Date.now() + 60_000);
    assert.equal(summary.totals.chatTurns, 1);
    assert.equal(summary.totals.requests, 1);
    assert.equal(summary.bySource[0]?.source, "web_chat");
    assert.equal(summary.totals.inputTokens, 100);
    assert.equal(summary.totals.outputTokens, 20);
    assert.equal(summary.byModel[0]?.model, "gpt-4o-mini");
  });
});
