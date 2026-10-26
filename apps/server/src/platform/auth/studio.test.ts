import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NextFunction, Request, Response } from "express";
import { resolveStudioAuth } from "./studio.js";

function invoke(
  middleware: (req: Request, res: Response, next: NextFunction) => Promise<void>,
  path: string,
  authorization?: string,
): Promise<{ status?: number; body?: unknown; nextCalled: boolean }> {
  let nextCalled = false;
  let status: number | undefined;
  let body: unknown;
  const req = {
    path,
    method: "GET",
    header: (name: string) => (name.toLowerCase() === "authorization" ? authorization : undefined),
  } as Request;
  const res = {
    locals: {},
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    },
  } as unknown as Response;
  return middleware(req, res, () => {
    nextCalled = true;
  }).then(() => ({ status, body, nextCalled }));
}

describe("studio auth middleware", () => {
  it("stays open when no deployment token is configured", async () => {
    delete process.env.STUDIO_API_TOKEN;
    delete process.env.SERVER_API_TOKEN;
    const auth = resolveStudioAuth({ token: undefined });
    assert.equal(auth.enabled, false);
    const result = await invoke(auth.middleware, "/api/sessions");
    assert.equal(result.nextCalled, true);
    assert.equal(result.status, undefined);
  });

  it("protects management APIs but keeps health and external workflow APIs open", async () => {
    const auth = resolveStudioAuth({ token: "deploy-token" });
    assert.equal(auth.enabled, true);

    const blocked = await invoke(auth.middleware, "/api/admin/providers");
    assert.equal(blocked.nextCalled, false);
    assert.equal(blocked.status, 401);

    const allowedHealth = await invoke(auth.middleware, "/health");
    assert.equal(allowedHealth.nextCalled, true);

    const allowedExternalRun = await invoke(auth.middleware, "/v1/workflows/demo/run");
    assert.equal(allowedExternalRun.nextCalled, true);
  });

  it("accepts a valid bearer token for both manage and run scopes", async () => {
    const auth = resolveStudioAuth({ token: "deploy-token" });
    const manage = await invoke(auth.middleware, "/api/workflows", "Bearer deploy-token");
    assert.equal(manage.nextCalled, true);
    const run = await invoke(auth.middleware, "/api/chat", "Bearer deploy-token");
    assert.equal(run.nextCalled, true);
  });

  it("does not misclassify similarly named paths as management APIs", () => {
    const auth = resolveStudioAuth({ token: "deploy-token" });
    assert.equal(auth.requiredScope("/api/workflows"), "manage");
    assert.equal(auth.requiredScope("/api/workflows-extra"), "run");
    assert.equal(auth.requiredScope("/api"), "run");
    // 读接口与运行接口不属于 manage，避免把普通使用者挡在门外。
    assert.equal(auth.requiredScope("/api/providers"), "run");
    assert.equal(auth.requiredScope("/api/schema-sources"), "run");
    assert.equal(auth.requiredScope("/v1/workflows/demo/run"), null);
  });

  it("fails closed when enterprise identity configuration is incomplete", async () => {
    process.env.OIDC_ISSUER = "https://id.example.test";
    try {
      const auth = resolveStudioAuth({ token: "" });
      assert.equal(auth.enabled, true);
      assert.equal(auth.status.configError?.includes("configured together"), true);
      const result = await invoke(auth.middleware, "/api/admin/providers", "Bearer deploy-token");
      assert.equal(result.status, 503);
      assert.equal(result.nextCalled, false);
      const health = await invoke(auth.middleware, "/health");
      assert.equal(health.nextCalled, true);
    } finally {
      delete process.env.OIDC_ISSUER;
    }
  });
});
