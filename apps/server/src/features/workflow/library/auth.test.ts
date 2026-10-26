import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Request } from "express";
import { closeDb } from "../../../platform/db.js";
import {
  authorizeWorkflowRequest,
  createWorkflowApiKey,
  resetWorkflowRateLimitsForTest,
} from "./auth.js";
import { createWorkflow, insertWorkflowApiKey, revokeWorkflowApiKey } from "./store.js";

function requestWithKey(rawKey: string): Request {
  return {
    header(name: string) {
      return name.toLowerCase() === "authorization" ? `Bearer ${rawKey}` : undefined;
    },
  } as Request;
}

describe("workflow API key auth", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "workflow-auth-"));
    process.env.SQLITE_PATH = join(dir, "test.sqlite");
    closeDb();
    resetWorkflowRateLimitsForTest();
  });

  afterEach(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SQLITE_PATH;
  });

  it("creates a one-time raw key and authorizes only its workflow", async () => {
    const workflow = createWorkflow({ name: "Auth test" });
    const other = createWorkflow({ name: "Other" });
    const created = await createWorkflowApiKey({
      workflowId: workflow.app.id,
      name: "CI",
      rateLimitPerMinute: 2,
    });
    assert.match(created.rawKey, /^wf\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    assert.equal("keyHash" in created.key, false);

    const allowed = await authorizeWorkflowRequest(requestWithKey(created.rawKey), workflow.app.id);
    assert.equal(allowed.ok, true);

    const denied = await authorizeWorkflowRequest(requestWithKey(created.rawKey), other.app.id);
    assert.deepEqual(denied, {
      ok: false,
      status: 403,
      error: "workflow API key is not authorized for this workflow",
    });

    assert.equal(revokeWorkflowApiKey(workflow.app.id, created.key.id), true);
    const revoked = await authorizeWorkflowRequest(requestWithKey(created.rawKey), workflow.app.id);
    assert.equal(revoked.ok, false);
    if (!revoked.ok) assert.equal(revoked.status, 401);
  });

  it("enforces per-key minute limits", async () => {
    const workflow = createWorkflow({ name: "Rate test" });
    const created = await createWorkflowApiKey({
      workflowId: workflow.app.id,
      name: "limited",
      rateLimitPerMinute: 1,
    });
    assert.equal(
      (await authorizeWorkflowRequest(requestWithKey(created.rawKey), workflow.app.id)).ok,
      true,
    );
    const limited = await authorizeWorkflowRequest(requestWithKey(created.rawKey), workflow.app.id);
    assert.equal(limited.ok, false);
    if (!limited.ok) assert.equal(limited.status, 429);
  });

  it("authorizes historical workflow hashes while retaining key prefix and expiry checks", async () => {
    const workflow = createWorkflow({ name: "Legacy auth" });
    const id = "4d36e967-e325-11ce-bfc1-08002be10318";
    const secret = Buffer.alloc(32, 7).toString("base64url");
    const salt = Buffer.alloc(16, 9);
    const derived = scryptSync(secret, salt, 32, {
      N: 16_384,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
    const keyHash = `scrypt$16384$8$1$${salt.toString("base64url")}$${derived.toString("base64url")}$legacy`;
    const record = {
      id,
      workflowId: workflow.app.id,
      name: "Legacy",
      keyHash,
      prefix: "wf.legacy...",
      status: "ACTIVE" as const,
      rateLimitPerMinute: 60,
      expiresAt: null,
      lastUsedAt: null,
      createdAt: new Date().toISOString(),
    };
    insertWorkflowApiKey(record);
    assert.equal(
      (await authorizeWorkflowRequest(requestWithKey(`wf.${id}.${secret}`), workflow.app.id)).ok,
      true,
    );
    assert.equal(
      (await authorizeWorkflowRequest(requestWithKey(`mcp.${id}.${secret}`), workflow.app.id)).ok,
      false,
    );
    assert.equal(
      (
        await authorizeWorkflowRequest(
          requestWithKey(`wf.${id}.${Buffer.alloc(32, 8).toString("base64url")}`),
          workflow.app.id,
        )
      ).ok,
      false,
    );
    insertWorkflowApiKey({
      ...record,
      id: "4d36e967-e325-11ce-bfc1-08002be10319",
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    assert.deepEqual(
      await authorizeWorkflowRequest(
        requestWithKey(`wf.4d36e967-e325-11ce-bfc1-08002be10319.${secret}`),
        workflow.app.id,
      ),
      {
        ok: false,
        status: 401,
        error: "workflow API key is inactive",
      },
    );
  });

  it("rejects missing and malformed Bearer credentials", async () => {
    for (const header of [undefined, "", "Basic abc", "Bearer ", "Bearer wf.invalid.secret"]) {
      const req = { header: () => header } as unknown as Request;
      const result = await authorizeWorkflowRequest(req, "workflow");
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.status, 401);
    }
  });
});
