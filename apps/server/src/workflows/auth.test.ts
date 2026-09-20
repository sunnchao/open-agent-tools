import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Request } from "express";
import { closeDb } from "../db.js";
import {
  authorizeWorkflowRequest,
  createWorkflowApiKey,
  resetWorkflowRateLimitsForTest,
} from "./auth.js";
import { createWorkflow, revokeWorkflowApiKey } from "./store.js";

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
});
