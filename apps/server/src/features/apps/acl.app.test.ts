import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createApp } from "../../app.js";
import { closeDb } from "../../platform/db.js";
import { createProvider, setDefaultProvider } from "../providers/store.js";
import { resetViewerAssertionReplays } from "../../platform/auth/viewer.js";

let server: Server;
let origin: string;
let dir: string;
let originalFetch: typeof globalThis.fetch;
let ragRequest: unknown = null;
let graphRequest: unknown = null;
const assertionSecret = "test-assertion-secret-with-at-least-32-characters";

const auth = { authorization: "Bearer deploy-token" };

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "published-app-acl-test-"));
  process.env.NODE_ENV = "test";
  process.env.SQLITE_PATH = join(dir, "test.sqlite");
  process.env.CONFIG_SECRETS_ENCRYPTION_KEY =
    "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
  process.env.STUDIO_API_TOKEN = "deploy-token";
  process.env.PUBLISHED_APP_ASSERTION_HMAC_SECRET = assertionSecret;
  process.env.PUBLISHED_APP_ASSERTION_KEY_ID = "gw-test";
  process.env.PUBLISHED_APP_ASSERTION_ISSUER = "corp-sso-gateway";
  process.env.PUBLISHED_APP_ASSERTION_AUDIENCE = "open-agent-tools-server";
  process.env.PUBLISHED_APP_ASSERTION_MAX_SKEW_SECONDS = "30";
  process.env.PUBLISHED_APP_ASSERTION_MAX_AGE_SECONDS = "60";
  process.env.PUBLISHED_APP_IDENTITY_MODE = "required_for_groups";
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
    const url = String(input);
    if (url.includes(":4001/api/query")) {
      ragRequest = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({
          chunks: [
            {
              source: "public.md",
              chunkIndex: 0,
              content: "员工年假为 10 天。",
              score: 0.91,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes(":4001/api/graph/retrieve")) {
      graphRequest = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ formatted: "", seeds: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (!url.includes("/chat/completions")) return originalFetch(input, init);
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
  delete process.env.PUBLISHED_APP_ASSERTION_HMAC_SECRET;
  delete process.env.PUBLISHED_APP_ASSERTION_KEY_ID;
  delete process.env.PUBLISHED_APP_ASSERTION_ISSUER;
  delete process.env.PUBLISHED_APP_ASSERTION_AUDIENCE;
  delete process.env.PUBLISHED_APP_ASSERTION_MAX_SKEW_SECONDS;
  delete process.env.PUBLISHED_APP_ASSERTION_MAX_AGE_SECONDS;
  delete process.env.PUBLISHED_APP_IDENTITY_MODE;
  rmSync(dir, { recursive: true, force: true });
});

async function createAclApp(): Promise<string> {
  const response = await fetch(`${origin}/api/admin/published-apps`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({
      name: "ACL App",
      slug: "acl-app",
      allowedGroups: ["hr", "*"],
      resources: { rag: { sources: ["public.md", "hr.md"], topK: 3 } },
    }),
  });
  assert.equal(response.status, 201);
  const app = (await response.json()) as { app: { id: string; allowedGroups: string[] } };
  assert.deepEqual(app.app.allowedGroups, ["hr"]);
  return app.app.id;
}

function assertion(body: string, groups: string[] = ["hr"], patch: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: "corp-sso-gateway",
    aud: "open-agent-tools-server",
    sub: "alice@example.com",
    app: "acl-app",
    groups,
    iat: now,
    exp: now + 60,
    jti: randomBytes(12).toString("base64url"),
    method: "POST",
    path: "/api/apps/acl-app/chat",
    query_sha256: createHash("sha256").update("", "utf8").digest("base64url"),
    body_sha256: createHash("sha256").update(body, "utf8").digest("base64url"),
    ...patch,
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signingInput = `v1.gw-test.${payload}`;
  const signature = createHmac("sha256", assertionSecret)
    .update(signingInput, "utf8")
    .digest("base64url");
  return `${signingInput}.${signature}`;
}

async function chat(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${origin}/api/apps/acl-app/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function signedChat(
  groups: string[] = ["hr"],
  patch: Record<string, unknown> = {},
): Promise<Response> {
  const body = {
    messages: [{ role: "user", content: "年假几天？" }],
    sessionId: `s-${randomBytes(6).toString("hex")}`,
  };
  const raw = JSON.stringify(body);
  return fetch(`${origin}/api/apps/acl-app/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-viewer-assertion": assertion(raw, groups, patch),
    },
    body: raw,
  });
}

describe("published app document ACL", () => {
  it("forwards verified caller groups to RAG and graph retrieval", async () => {
    await createAclApp();
    resetViewerAssertionReplays();
    ragRequest = null;
    graphRequest = null;

    const response = await signedChat(["hr"]);
    assert.equal(response.status, 200);
    await response.text();

    assert.deepEqual((ragRequest as { viewerGroups?: string[] }).viewerGroups, ["hr"]);
    assert.deepEqual((graphRequest as { sources?: string[] }).sources, ["public.md", "hr.md"]);
    assert.deepEqual((graphRequest as { viewerGroups?: string[] }).viewerGroups, ["hr"]);
  });

  it("rejects caller-supplied viewerGroups instead of silently trusting them", async () => {
    const response = await chat({
      messages: [{ role: "user", content: "年假几天？" }],
      viewerGroups: ["hr"],
    });
    assert.equal(response.status, 400);
    assert.match(((await response.json()) as { error: string }).error, /verified identity/);
  });

  it("does not let a verified caller borrow groups the app did not declare", async () => {
    resetViewerAssertionReplays();
    ragRequest = null;
    graphRequest = null;

    const response = await signedChat(["finance", "admin"]);
    assert.equal(response.status, 200);
    await response.text();

    assert.deepEqual((ragRequest as { viewerGroups?: string[] }).viewerGroups, []);
    assert.deepEqual((graphRequest as { viewerGroups?: string[] }).viewerGroups, []);
  });

  it("requires an assertion for apps that declare groups", async () => {
    const response = await chat({
      messages: [{ role: "user", content: "年假几天？" }],
    });
    assert.equal(response.status, 401);
  });

  it("rejects an invalid signature before calling RAG or the model", async () => {
    resetViewerAssertionReplays();
    ragRequest = null;
    graphRequest = null;
    const body = {
      messages: [{ role: "user", content: "年假几天？" }],
      sessionId: "s2",
    };
    const raw = JSON.stringify(body);
    const response = await fetch(`${origin}/api/apps/acl-app/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-viewer-assertion": assertion(raw).replace(/.$/, "x"),
      },
      body: raw,
    });
    assert.equal(response.status, 401);
    assert.equal(ragRequest, null);
    assert.equal(graphRequest, null);
  });

  it("rejects replayed assertions", async () => {
    resetViewerAssertionReplays();
    const body = {
      messages: [{ role: "user", content: "年假几天？" }],
      sessionId: "replay",
    };
    const raw = JSON.stringify(body);
    const headers = {
      "content-type": "application/json",
      "x-viewer-assertion": assertion(raw),
    };
    assert.equal(
      (await fetch(`${origin}/api/apps/acl-app/chat`, { method: "POST", headers, body: raw }))
        .status,
      200,
    );
    assert.equal(
      (await fetch(`${origin}/api/apps/acl-app/chat`, { method: "POST", headers, body: raw }))
        .status,
      401,
    );
  });

  it("does not expose internal group names on the public app profile", async () => {
    const response = await fetch(`${origin}/api/apps/acl-app`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { app: Record<string, unknown> };
    assert.equal("allowedGroups" in body.app, false);
  });
});
