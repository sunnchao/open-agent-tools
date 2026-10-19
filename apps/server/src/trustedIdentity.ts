import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { openDb } from "./db.js";

export type PublishedAppIdentityMode = "optional" | "required" | "required_for_groups";

export interface ViewerAssertionClaims {
  iss: string;
  aud: string;
  sub: string;
  app: string;
  groups: string[];
  iat: number;
  exp: number;
  jti: string;
  method: string;
  path: string;
  query_sha256: string | null;
  body_sha256: string;
}

export interface VerifiedViewer {
  subject: string;
  subjectHash: string;
  groups: string[];
  jti: string;
  claims: ViewerAssertionClaims;
}

export interface ViewerAssertionOptions {
  secret: string;
  keyId: string;
  issuer: string;
  audience: string;
  maxSkewSeconds: number;
  maxAgeSeconds: number;
  now?: number;
}

export type ViewerAssertionResult =
  { ok: true; viewer: VerifiedViewer } | { ok: false; reason: string };

const ASSERTION_PATTERN = /^v1\.([A-Za-z0-9._-]{1,80})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

function decodeJson(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeGroups(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 50) return null;
  const groups: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const group = item.trim();
    if (!group || group.length > 60 || group === "*") return null;
    if (!groups.includes(group)) groups.push(group);
  }
  return groups;
}

function parseClaims(value: unknown): ViewerAssertionClaims | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const claims = value as Record<string, unknown>;
  const iss = normalizeString(claims.iss);
  const aud = normalizeString(claims.aud);
  const sub = normalizeString(claims.sub);
  const app = normalizeString(claims.app);
  const groups = normalizeGroups(claims.groups);
  const jti = normalizeString(claims.jti);
  const method = normalizeString(claims.method);
  const path = normalizeString(claims.path);
  const bodySha = normalizeString(claims.body_sha256);
  if (
    !iss ||
    !aud ||
    !sub ||
    !app ||
    !groups ||
    !jti ||
    !method ||
    !path ||
    !bodySha ||
    typeof claims.iat !== "number" ||
    typeof claims.exp !== "number" ||
    (claims.query_sha256 !== null && typeof claims.query_sha256 !== "string")
  ) {
    return null;
  }
  return {
    iss,
    aud,
    sub,
    app,
    groups,
    iat: claims.iat,
    exp: claims.exp,
    jti,
    method,
    path,
    query_sha256: claims.query_sha256,
    body_sha256: bodySha,
  };
}

function readRawBody(req: Request): Buffer | null {
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  return Buffer.isBuffer(raw) ? raw : null;
}

function canonicalQuery(req: Request): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    if (Array.isArray(value)) {
      value.forEach((item) => params.append(key, String(item)));
    } else if (value !== undefined) {
      params.append(key, String(value));
    }
  }
  params.sort();
  return params.toString();
}

function bodyDigest(req: Request): string | null {
  const raw = readRawBody(req);
  return raw ? createHash("sha256").update(raw).digest("base64url") : null;
}

function queryDigest(req: Request): string {
  return createHash("sha256").update(canonicalQuery(req), "utf8").digest("base64url");
}

function safeEqual(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function replayKey(issuer: string, keyId: string, jti: string): string {
  return `${issuer}:${keyId}:${jti}`;
}

/** 原子登记 jti；所有实例共享同一 SQLite 时也能防重放。 */
function claimReplay(issuer: string, keyId: string, jti: string, expiresAt: number): boolean {
  const db = openDb();
  const now = Date.now();
  db.prepare(`DELETE FROM viewer_assertion_replays WHERE expires_at <= ?`).run(now);
  try {
    db.prepare(
      `INSERT INTO viewer_assertion_replays (replay_key, expires_at, created_at)
       VALUES (?, ?, ?)`,
    ).run(replayKey(issuer, keyId, jti), expiresAt, now);
    return true;
  } catch {
    return false;
  }
}

export function resetViewerAssertionReplays(): void {
  openDb().prepare(`DELETE FROM viewer_assertion_replays`).run();
}

export function verifyViewerAssertion(
  header: string | undefined,
  req: Request,
  appSlug: string,
  options: ViewerAssertionOptions,
): ViewerAssertionResult {
  if (!header) return { ok: false, reason: "missing assertion" };
  if (header.length > 16_384) return { ok: false, reason: "assertion is too large" };
  const match = ASSERTION_PATTERN.exec(header);
  if (!match) return { ok: false, reason: "malformed assertion" };
  const [, keyId = "", payload = "", signature = ""] = match;
  if (keyId !== options.keyId) return { ok: false, reason: "unknown key id" };
  const signingInput = `v1.${keyId}.${payload}`;
  const expected = createHmac("sha256", options.secret)
    .update(signingInput, "utf8")
    .digest("base64url");
  if (!safeEqual(expected, signature)) return { ok: false, reason: "invalid signature" };

  let claims: ViewerAssertionClaims | null;
  try {
    claims = parseClaims(decodeJson(payload));
  } catch {
    return { ok: false, reason: "invalid payload" };
  }
  if (!claims) return { ok: false, reason: "invalid claims" };

  const now = options.now ?? Math.floor(Date.now() / 1000);
  const skew = Math.max(0, options.maxSkewSeconds);
  const maxAge = Math.max(1, options.maxAgeSeconds);
  if (claims.iss !== options.issuer) return { ok: false, reason: "issuer mismatch" };
  if (claims.aud !== options.audience) return { ok: false, reason: "audience mismatch" };
  if (claims.app !== appSlug) return { ok: false, reason: "application mismatch" };
  if (claims.method !== req.method) return { ok: false, reason: "method mismatch" };
  if (claims.path !== req.path) return { ok: false, reason: "path mismatch" };
  if (claims.iat > now + skew) return { ok: false, reason: "issued in the future" };
  if (claims.exp < now - skew) return { ok: false, reason: "assertion expired" };
  if (claims.exp <= claims.iat || claims.exp - claims.iat > maxAge) {
    return { ok: false, reason: "invalid validity window" };
  }

  const digest = bodyDigest(req);
  if (!digest || claims.body_sha256 !== digest)
    return { ok: false, reason: "body digest mismatch" };
  const query = queryDigest(req);
  if (claims.query_sha256 !== query) return { ok: false, reason: "query digest mismatch" };

  // 重放记录必须覆盖断言可被接受的最长窗口；不能拿测试用的固定 now 当系统时钟。
  const replayExpiresAt = Math.max(
    (claims.exp + skew + 1) * 1000,
    Date.now() + (options.maxAgeSeconds + skew + 1) * 1000,
  );
  if (!claimReplay(claims.iss, keyId, claims.jti, replayExpiresAt)) {
    return { ok: false, reason: "assertion replay" };
  }
  return {
    ok: true,
    viewer: {
      subject: claims.sub,
      subjectHash: createHash("sha256").update(claims.sub, "utf8").digest("hex").slice(0, 24),
      groups: claims.groups,
      jti: claims.jti,
      claims,
    },
  };
}

export function identityMode(env: NodeJS.ProcessEnv = process.env): PublishedAppIdentityMode {
  const value = env.PUBLISHED_APP_IDENTITY_MODE?.trim();
  return value === "required" || value === "required_for_groups" ? value : "optional";
}

export function viewerAssertionOptions(
  env: NodeJS.ProcessEnv = process.env,
): ViewerAssertionOptions | null {
  const secret = env.PUBLISHED_APP_ASSERTION_HMAC_SECRET?.trim();
  const keyId = env.PUBLISHED_APP_ASSERTION_KEY_ID?.trim();
  if (!secret || !keyId) return null;
  return {
    secret,
    keyId,
    issuer: env.PUBLISHED_APP_ASSERTION_ISSUER?.trim() || "corp-sso-gateway",
    audience: env.PUBLISHED_APP_ASSERTION_AUDIENCE?.trim() || "open-agent-tools-server",
    maxSkewSeconds: Math.max(0, Number(env.PUBLISHED_APP_ASSERTION_MAX_SKEW_SECONDS) || 30),
    maxAgeSeconds: Math.max(1, Number(env.PUBLISHED_APP_ASSERTION_MAX_AGE_SECONDS) || 60),
  };
}

export function gatewayConnectionDetails(env: NodeJS.ProcessEnv = process.env): {
  enabled: boolean;
  keyId: string | null;
  issuer: string;
  audience: string;
  identityMode: PublishedAppIdentityMode;
  assertionHeader: "X-Viewer-Assertion";
} {
  const options = viewerAssertionOptions(env);
  return {
    enabled: Boolean(options),
    keyId: options?.keyId ?? null,
    issuer: options?.issuer ?? env.PUBLISHED_APP_ASSERTION_ISSUER?.trim() ?? "corp-sso-gateway",
    audience:
      options?.audience ??
      env.PUBLISHED_APP_ASSERTION_AUDIENCE?.trim() ??
      "open-agent-tools-server",
    identityMode: identityMode(env),
    assertionHeader: "X-Viewer-Assertion",
  };
}
