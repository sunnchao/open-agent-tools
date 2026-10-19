import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createApp } from "./app.js";
import { closeDb } from "./db.js";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";

const TOKEN = "deploy-token-for-test";
const OIDC_ISSUER = "https://idp.example.test";
const OIDC_AUDIENCE = "studio-test";

let server: Server;
let origin: string;
let dir: string;
let keySet: ReturnType<typeof createLocalJWKSet>;
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let oidcServer: Server;
let oidcOrigin: string;

async function oidcToken(input: {
  sub?: string;
  roles?: string[];
  expiresIn?: number;
  audience?: string;
  issuer?: string;
}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ roles: input.roles ?? ["studio-member"], groups: ["hr"] })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(input.issuer ?? OIDC_ISSUER)
    .setAudience(input.audience ?? OIDC_AUDIENCE)
    .setSubject(input.sub ?? "user-1")
    .setIssuedAt(now)
    .setExpirationTime(now + (input.expiresIn ?? 300))
    .sign(privateKey);
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "studio-auth-e2e-"));
  const fixture = await generateKeyPair("RS256");
  privateKey = fixture.privateKey;
  const publicJwk = await exportJWK(fixture.publicKey);
  publicJwk.kid = "test-key";
  publicJwk.alg = "RS256";
  keySet = createLocalJWKSet({ keys: [publicJwk] });
  process.env.SQLITE_PATH = join(dir, "test.sqlite");
  process.env.CONFIG_SECRETS_ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  // 部署 token 在 createApp() 调用时读取，因此必须先于建 app 设置。
  process.env.STUDIO_API_TOKEN = TOKEN;
  delete process.env.SERVER_API_TOKEN;
  delete process.env.OIDC_ISSUER;
  delete process.env.OIDC_AUDIENCE;
  delete process.env.OIDC_JWKS_URI;
  delete process.env.LDAP_TRUSTED_GATEWAY_URL;
  delete process.env.PUBLISHED_APP_ASSERTION_HMAC_SECRET;
  server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;

  oidcServer = createApp({
    studioAuth: {
      token: TOKEN,
      oidc: {
        issuer: OIDC_ISSUER,
        audience: OIDC_AUDIENCE,
        jwksUri: "https://idp.example.test/.well-known/jwks.json",
        groupsClaim: "groups",
        rolesClaim: "roles",
        adminRoles: ["studio-admin"],
        algorithms: ["RS256", "ES256"],
        maxTokenAgeSeconds: null,
        clockToleranceSeconds: 0,
      },
      oidcKeySet: keySet,
    },
  }).listen(0, "127.0.0.1");
  await once(oidcServer, "listening");
  const oidcAddress = oidcServer.address();
  assert.ok(oidcAddress && typeof oidcAddress === "object");
  oidcOrigin = `http://127.0.0.1:${oidcAddress.port}`;
});

after(async () => {
  server.close();
  await once(server, "close");
  oidcServer.close();
  await once(oidcServer, "close");
  closeDb();
  delete process.env.SQLITE_PATH;
  delete process.env.CONFIG_SECRETS_ENCRYPTION_KEY;
  delete process.env.STUDIO_API_TOKEN;
  delete process.env.OIDC_ISSUER;
  delete process.env.OIDC_AUDIENCE;
  delete process.env.OIDC_JWKS_URI;
  delete process.env.LDAP_TRUSTED_GATEWAY_URL;
  delete process.env.PUBLISHED_APP_ASSERTION_HMAC_SECRET;
  rmSync(dir, { recursive: true, force: true });
});

describe("studio deployment token guard", () => {
  it("keeps health check public", async () => {
    const response = await fetch(`${origin}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  });

  it("rejects unauthenticated access to management and run APIs", async () => {
    const admin = await fetch(`${origin}/api/admin/providers`);
    assert.equal(admin.status, 401);
    assert.deepEqual(await admin.json(), { error: "studio authentication is required" });

    const chat = await fetch(`${origin}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    });
    assert.equal(chat.status, 401);
  });

  it("rejects a wrong token", async () => {
    const response = await fetch(`${origin}/api/sessions`, {
      headers: { authorization: "Bearer not-the-token" },
    });
    assert.equal(response.status, 401);
  });

  it("serves protected APIs once the bearer token matches", async () => {
    const sessions = await fetch(`${origin}/api/sessions`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(sessions.status, 200);

    const providers = await fetch(`${origin}/api/admin/providers`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(providers.status, 200);

    // 鉴权通过后应进入业务校验：无 Provider 时返回 400 而不是 401。
    const chat = await fetch(`${origin}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    });
    assert.notEqual(chat.status, 401);
  });
});

describe("studio OIDC guard", () => {
  it("accepts an OIDC admin for manage endpoints and exposes read-only identity status", async () => {
    const jwt = await oidcToken({ roles: ["studio-admin"] });
    process.env.OIDC_ISSUER = OIDC_ISSUER;
    process.env.OIDC_AUDIENCE = OIDC_AUDIENCE;
    process.env.OIDC_JWKS_URI = "https://idp.example.test/.well-known/jwks.json";
    process.env.PUBLISHED_APP_ASSERTION_HMAC_SECRET = "super-secret-hmac";
    const response = await fetch(`${oidcOrigin}/api/admin/identity/status`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      identity: {
        provider: string;
        issuer: string;
        audience: string;
        groupsClaim: string;
        mode: string;
      };
    };
    assert.equal(body.identity.provider, "oidc");
    assert.equal(body.identity.issuer, OIDC_ISSUER);
    assert.equal(body.identity.audience, OIDC_AUDIENCE);
    assert.equal(body.identity.groupsClaim, "groups");
    assert.equal(body.identity.mode, "oidc");
    assert.equal(JSON.stringify(body).includes("deploy-token-for-test"), false);
    assert.equal(JSON.stringify(body).includes("super-secret-hmac"), false);
    delete process.env.OIDC_ISSUER;
    delete process.env.OIDC_AUDIENCE;
    delete process.env.OIDC_JWKS_URI;
    delete process.env.PUBLISHED_APP_ASSERTION_HMAC_SECRET;
  });

  it("allows an OIDC member to use run endpoints but not manage endpoints", async () => {
    const jwt = await oidcToken({ roles: ["studio-member"] });
    const sessions = await fetch(`${oidcOrigin}/api/sessions`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    assert.equal(sessions.status, 200);

    const providers = await fetch(`${oidcOrigin}/api/admin/providers`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    assert.equal(providers.status, 403);
    assert.deepEqual(await providers.json(), { error: "admin role is required" });
  });

  it("rejects a wrong audience, expired token, and forged role", async () => {
    const wrongAudience = await oidcToken({ audience: "another-app", roles: ["studio-admin"] });
    const wrongAudienceResponse = await fetch(`${oidcOrigin}/api/admin/providers`, {
      headers: { authorization: `Bearer ${wrongAudience}` },
    });
    assert.equal(wrongAudienceResponse.status, 401);

    const expired = await oidcToken({ expiresIn: -60, roles: ["studio-admin"] });
    const expiredResponse = await fetch(`${oidcOrigin}/api/admin/providers`, {
      headers: { authorization: `Bearer ${expired}` },
    });
    assert.equal(expiredResponse.status, 401);

    const wrongRole = await oidcToken({ roles: ["hr-admin"] });
    const wrongRoleResponse = await fetch(`${oidcOrigin}/api/admin/providers`, {
      headers: { authorization: `Bearer ${wrongRole}` },
    });
    assert.equal(wrongRoleResponse.status, 403);
  });

  it("keeps the deployment token as an explicit fallback when OIDC is configured", async () => {
    const response = await fetch(`${oidcOrigin}/api/admin/providers`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.status, 200);
  });
});
