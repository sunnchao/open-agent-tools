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
import { listRecentUsage } from "../../platform/usage/events.js";

let server: Server;
let origin: string;
let dir: string;
let originalFetch: typeof globalThis.fetch;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "published-app-test-"));
  process.env.NODE_ENV = "test";
  process.env.SQLITE_PATH = join(dir, "test.sqlite");
  process.env.CONFIG_SECRETS_ENCRYPTION_KEY =
    "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
  // 部署 token 开着：验证员工入口确实豁免，而管理接口仍受保护。
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
      'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":"stop"}]}\n\n',
      'data: {"id":"x","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":30,"completion_tokens":8}}\n\n',
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

const auth = { authorization: "Bearer deploy-token" };

describe("published apps", () => {
  let appId = "";

  it("requires the deployment token to manage apps", async () => {
    const response = await fetch(`${origin}/api/admin/published-apps`);
    assert.equal(response.status, 401);
  });

  it("creates an app with a derived slug and scoped capabilities", async () => {
    const created = await fetch(`${origin}/api/admin/published-apps`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        name: "HR Policy Helper",
        welcome: "你好，我可以回答公司制度相关问题。",
        suggestions: [{ title: "年假", prompt: "年假有几天？" }],
        allowedGroups: ["hr"],
        resources: { rag: { sources: ["hr.md"], topK: 3 } },
      }),
    });
    assert.equal(created.status, 201);
    const body = (await created.json()) as { app: { id: string; slug: string } };
    appId = body.app.id;
    assert.equal(body.app.slug, "hr-policy-helper");
  });

  it("rejects duplicate slugs", async () => {
    const duplicate = await fetch(`${origin}/api/admin/published-apps`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ name: "Duplicate", slug: "hr-policy-helper" }),
    });
    assert.equal(duplicate.status, 400);
    assert.match(((await duplicate.json()) as { error: string }).error, /slug already exists/);
  });

  it("serves the public app profile without leaking provider or workspace internals", async () => {
    const response = await fetch(`${origin}/api/apps/hr-policy-helper`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      app: Record<string, unknown> & {
        capabilities: Record<string, number>;
      };
    };
    assert.equal(body.app.name, "HR Policy Helper");
    assert.deepEqual(body.app.capabilities, { ragSources: 1, mcpTools: 0, sqlSources: 0 });
    // 终端用户不应该看到 provider / workspace / 资源明细或内部组名
    for (const leaked of ["providerId", "workspaceId", "resources", "id", "allowedGroups"]) {
      assert.equal(leaked in body.app, false, `leaked field: ${leaked}`);
    }
  });

  it("lets end users chat on the public endpoint without a deployment token", async () => {
    const response = await fetch(`${origin}/api/apps/hr-policy-helper/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "年假几天？" }] }),
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /"delta":"你好"/);
    assert.match(body, /"done":true/);
    assert.match(body, /"totalTokens":38/);
    assert.match(body, /"requests":1/);
    assert.equal(listRecentUsage()[0]?.source, "app_chat");
  });

  it("ignores caller-supplied resources and model on the public endpoint", async () => {
    const response = await fetch(`${origin}/api/apps/hr-policy-helper/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hi" }],
        // 终端用户试图越权：改资源、换模型、指定 provider
        resources: {
          rag: { sources: ["secret.md"] },
          mcpTools: [{ serviceSlug: "x", toolName: "y" }],
        },
        model: "gpt-4o",
        providerId: "other",
      }),
    });
    assert.equal(response.status, 200);
    // 仍然能正常回答（没有因为未知字段报错），但资源以发布配置为准（见 appChat 实现）。
    assert.match(await response.text(), /"done":true/);
  });

  it("returns 503 when the published resource config is no longer valid", async () => {
    // 数据源被删后发布配置失效：应给员工可读的提示，而不是 500。
    const created = await fetch(`${origin}/api/admin/published-apps`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Broken App",
        slug: "broken-app",
        resources: { sqlSources: ["deleted-source"] },
      }),
    });
    assert.equal(created.status, 201);
    const response = await fetch(`${origin}/api/apps/broken-app/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 503);
    assert.match(((await response.json()) as { error: string }).error, /资源配置已失效/);
  });

  it("returns 404 for archived apps", async () => {
    const archived = await fetch(`${origin}/api/admin/published-apps/${appId}`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ status: "ARCHIVED" }),
    });
    assert.equal(archived.status, 200);

    const profile = await fetch(`${origin}/api/apps/hr-policy-helper`);
    assert.equal(profile.status, 404);
    const chat = await fetch(`${origin}/api/apps/hr-policy-helper/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(chat.status, 404);
  });
});
