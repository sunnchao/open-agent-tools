import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Request } from "express";
import { closeDb } from "../db.js";
import {
  resetViewerAssertionReplays,
  verifyViewerAssertion,
  type ViewerAssertionClaims,
  type ViewerAssertionOptions,
} from "./viewer.js";

let dir: string;
const now = 1_760_000_000;
const options: ViewerAssertionOptions = {
  secret: "test-secret-with-at-least-32-characters",
  keyId: "gw-test",
  issuer: "corp-sso-gateway",
  audience: "open-agent-tools-server",
  maxSkewSeconds: 30,
  maxAgeSeconds: 60,
  now,
};

before(() => {
  dir = mkdtempSync(join(tmpdir(), "trusted-identity-"));
  process.env.SQLITE_PATH = join(dir, "test.sqlite");
});

after(() => {
  closeDb();
  delete process.env.SQLITE_PATH;
  rmSync(dir, { recursive: true, force: true });
});

function request(body: string, path = "/api/apps/hr/chat", method = "POST"): Request {
  return {
    method,
    path,
    query: {},
    rawBody: Buffer.from(body, "utf8"),
  } as unknown as Request;
}

function assertion(
  claimsPatch: Partial<ViewerAssertionClaims> = {},
  secret = options.secret,
  keyId = options.keyId,
  body = '{"messages":[{"role":"user","content":"hi"}]}',
  req = request(body),
): string {
  const claims: ViewerAssertionClaims = {
    iss: options.issuer,
    aud: options.audience,
    sub: "alice",
    app: "hr",
    groups: ["hr"],
    iat: now,
    exp: now + 60,
    jti: "jti-1",
    method: req.method,
    path: req.path,
    query_sha256: createHash("sha256").update("", "utf8").digest("base64url"),
    body_sha256: createHash("sha256").update(body, "utf8").digest("base64url"),
    ...claimsPatch,
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signingInput = `v1.${keyId}.${payload}`;
  const signature = createHmac("sha256", secret).update(signingInput, "utf8").digest("base64url");
  return `${signingInput}.${signature}`;
}

describe("viewer assertion verification", () => {
  it("accepts a correctly signed assertion and hashes the subject", () => {
    resetViewerAssertionReplays();
    const req = request('{"messages":[]}');
    const result = verifyViewerAssertion(
      assertion({}, options.secret, options.keyId, '{"messages":[]}', req),
      req,
      "hr",
      options,
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.viewer.groups, ["hr"]);
      assert.equal(result.viewer.subject, "alice");
      assert.match(result.viewer.subjectHash, /^[a-f0-9]{24}$/);
    }
  });

  it("rejects bad signatures, key ids, issuer, audience and time bounds", () => {
    resetViewerAssertionReplays();
    const req = request('{"messages":[]}');
    const cases = [
      assertion(
        {},
        "wrong-secret-with-at-least-32-characters",
        options.keyId,
        '{"messages":[]}',
        req,
      ),
      assertion({}, options.secret, "other-key", '{"messages":[]}', req),
      assertion({ iss: "evil" }, options.secret, options.keyId, '{"messages":[]}', req),
      assertion({ aud: "other" }, options.secret, options.keyId, '{"messages":[]}', req),
      assertion({ exp: now - 31 }, options.secret, options.keyId, '{"messages":[]}', req),
      assertion(
        { iat: now + 31, exp: now + 61 },
        options.secret,
        options.keyId,
        '{"messages":[]}',
        req,
      ),
      assertion({ exp: now + 61 }, options.secret, options.keyId, '{"messages":[]}', req),
    ];
    for (const value of cases) {
      assert.equal(verifyViewerAssertion(value, req, "hr", options).ok, false);
    }
  });

  it("binds the application, method, path, query and exact body", () => {
    resetViewerAssertionReplays();
    const req = request('{"messages":[]}');
    assert.equal(
      verifyViewerAssertion(
        assertion({}, options.secret, options.keyId, '{"messages":[]}', req),
        req,
        "other",
        options,
      ).ok,
      false,
    );
    assert.equal(
      verifyViewerAssertion(
        assertion({ method: "GET" }, options.secret, options.keyId, '{"messages":[]}', req),
        req,
        "hr",
        options,
      ).ok,
      false,
    );
    assert.equal(
      verifyViewerAssertion(
        assertion(
          { path: "/api/apps/other/chat" },
          options.secret,
          options.keyId,
          '{"messages":[]}',
          req,
        ),
        req,
        "hr",
        options,
      ).ok,
      false,
    );
    const tampered = request('{"messages":[{"role":"user","content":"changed"}]}');
    assert.equal(
      verifyViewerAssertion(
        assertion({}, options.secret, options.keyId, '{"messages":[]}', req),
        tampered,
        "hr",
        options,
      ).ok,
      false,
    );
  });

  it("rejects replayed jti and wildcard groups", () => {
    resetViewerAssertionReplays();
    // 断言使用秒级 exp；按 1 秒 TTL 清理时，同一秒内重放也必须被拒绝。
    assert.equal((process.env.SQLITE_PATH ?? "").length > 0, true);
    const req = request('{"messages":[]}');
    const value = assertion({}, options.secret, options.keyId, '{"messages":[]}', req);
    assert.equal(verifyViewerAssertion(value, req, "hr", options).ok, true);
    assert.equal(verifyViewerAssertion(value, req, "hr", options).ok, false);

    const wildcardReq = request('{"messages":[]}');
    assert.equal(
      verifyViewerAssertion(
        assertion({ groups: ["*"] }, options.secret, options.keyId, '{"messages":[]}', wildcardReq),
        wildcardReq,
        "hr",
        options,
      ).ok,
      false,
    );
  });

  it("rejects malformed, oversized and duplicate-ish invalid values without throwing", () => {
    const req = request('{"messages":[]}');
    for (const value of ["", "v1.bad", "v1.k.not-json.sig", `v1.${"x".repeat(20_000)}.e30.sig`]) {
      assert.equal(verifyViewerAssertion(value, req, "hr", options).ok, false);
    }
  });
});
