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
import { recordUsageEvent } from "../../platform/usage/events.js";
import { resetAppQuotaForTest } from "./quota.js";

let server: Server;
let origin: string;
let dir: string;
let originalFetch: typeof globalThis.fetch;

const auth = { authorization: "Bearer deploy-token" };

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "app-access-test-"));
  process.env.NODE_ENV = "test";
  process.env.SQLITE_PATH = join(dir, "test.sqlite");
  process.env.CONFIG_SECRETS_ENCRYPTION_KEY =
    "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
  process.env.STUDIO_API_TOKEN = "deploy-token";
  createProvider({
    id: "default",
    name: "OpenAI",
    baseUrl: "http://127.0.0.1:9/v1",
    models: ["gpt-4o-mini"],
    enabled: true,
    apiKey: "test-key",
  });
  setDefaultProvider("default");

  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).includes("/chat/completions")) return originalFetch(input, init);
    const encoder = new TextEncoder();
    const chunks = [
      'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
      'data: {"id":"x","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
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
  delete process.env.STUDIO_API_TOKEN;
  rmSync(dir, { recursive: true, force: true });
});

async function createApp_(body: Record<string, unknown>) {
  const response = await fetch(`${origin}/api/admin/published-apps`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 201);
  return ((await response.json()) as { app: { id: string; slug: string } }).app;
}

function chat(slug: string, headers: Record<string, string> = {}) {
  return fetch(`${origin}/api/apps/${slug}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
}

describe("published app access control", () => {
  it("issues a one-time token and rejects access without it", async () => {
    const app = await createApp_({ name: "Secure KB", slug: "secure-kb" });

    const rotated = await fetch(`${origin}/api/admin/published-apps/${app.id}/access-token`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ enable: true }),
    });
    assert.equal(rotated.status, 200);
    const { token, app: updated } = (await rotated.json()) as {
      token: string;
      app: { accessMode: string; accessTokenHint: string };
    };
    assert.ok(token && token.length > 20);
    assert.equal(updated.accessMode, "token");
    // 只回显掩码，不回显明文
    assert.equal(updated.accessTokenHint.includes(token), false);

    // 无口令：资料页与对话都 401
    const profile = await fetch(`${origin}/api/apps/secure-kb`);
    assert.equal(profile.status, 401);
    const denied = await chat("secure-kb");
    assert.equal(denied.status, 401);

    // 错误口令
    const wrong = await chat("secure-kb", { "x-app-access-token": "not-the-token" });
    assert.equal(wrong.status, 401);

    // 正确口令（请求头）
    const allowed = await chat("secure-kb", { "x-app-access-token": token });
    assert.equal(allowed.status, 200);

    // 正确口令（query，分享链接形态）
    const queryAllowed = await fetch(
      `${origin}/api/apps/secure-kb?access_token=${encodeURIComponent(token)}`,
    );
    assert.equal(queryAllowed.status, 200);
  });

  it("revokes the token back to public mode", async () => {
    const app = await createApp_({ name: "Revoke Me", slug: "revoke-me" });
    await fetch(`${origin}/api/admin/published-apps/${app.id}/access-token`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ enable: true }),
    });
    assert.equal((await fetch(`${origin}/api/apps/revoke-me`)).status, 401);

    const revoked = await fetch(`${origin}/api/admin/published-apps/${app.id}/access-token`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ enable: false }),
    });
    assert.equal(revoked.status, 200);
    assert.equal(((await revoked.json()) as { token: string | null }).token, null);
    assert.equal((await fetch(`${origin}/api/apps/revoke-me`)).status, 200);
  });
});

describe("published app quota", () => {
  it("enforces the per-minute request limit", async () => {
    resetAppQuotaForTest();
    const app = await createApp_({
      name: "Tight Limit",
      slug: "tight-limit",
      rateLimitPerMinute: 2,
    });
    assert.ok(app.id);

    assert.equal((await chat("tight-limit")).status, 200);
    assert.equal((await chat("tight-limit")).status, 200);
    const third = await chat("tight-limit");
    assert.equal(third.status, 429);
    assert.ok(third.headers.get("retry-after"));
    const body = (await third.json()) as { error: string; retryAfterSeconds: number };
    assert.match(body.error, /请求过于频繁/);
    assert.ok(body.retryAfterSeconds >= 1);
  });

  it("rejects when the daily token budget is exhausted", async () => {
    resetAppQuotaForTest();
    await createApp_({
      name: "Budget App",
      slug: "budget-app",
      rateLimitPerMinute: 0,
      dailyTokenBudget: 100,
    });
    // 该应用今日已消耗 150 token（会话 id 前缀归集到应用）
    recordUsageEvent({
      kind: "chat",
      workspaceId: "default",
      sessionId: "budget-app:abc",
      model: "gpt-4o-mini",
      inputTokens: 100,
      outputTokens: 50,
    });

    const response = await chat("budget-app");
    assert.equal(response.status, 429);
    const body = (await response.json()) as {
      error: string;
      usedTokensToday: number;
      dailyTokenBudget: number;
    };
    assert.match(body.error, /额度已用完/);
    assert.equal(body.usedTokensToday, 150);
    assert.equal(body.dailyTokenBudget, 100);
  });

  it("exposes quota state on the public profile", async () => {
    const response = await fetch(`${origin}/api/apps/budget-app`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      app: { quota: { dailyTokenBudget: number; usedTokensToday: number } };
    };
    assert.equal(body.app.quota.dailyTokenBudget, 100);
    assert.equal(body.app.quota.usedTokensToday, 150);
  });
});
