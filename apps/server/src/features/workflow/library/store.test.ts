import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { closeDb } from "../../../platform/db.js";
import {
  createWorkflow,
  deleteWorkflow,
  duplicateWorkflow,
  getWorkflow,
  listWorkflows,
  publishWorkflow,
  rollbackWorkflow,
  saveWorkflowDraft,
  claimWorkflowIdempotency,
  WorkflowConflictError,
} from "./store.js";

describe("workflow lifecycle storage", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "workflow-store-"));
    process.env.SQLITE_PATH = join(dir, "test.sqlite");
    closeDb();
  });

  afterEach(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SQLITE_PATH;
  });

  it("creates, lists, saves, duplicates, and soft-deletes workflows", () => {
    const created = createWorkflow({ name: "Customer Summary" });
    assert.equal(created.app.slug, "customer-summary");
    assert.equal(created.app.draftRevision, 1);
    assert.equal(listWorkflows().length, 1);

    const saved = saveWorkflowDraft(created.app.id, 1, {
      ...created.draft,
      name: "Customer Brief",
    });
    assert.equal(saved.app.name, "Customer Brief");
    assert.equal(saved.app.draftRevision, 2);
    assert.throws(() => saveWorkflowDraft(created.app.id, 1, saved.draft), WorkflowConflictError);

    const duplicate = duplicateWorkflow(created.app.id);
    assert.notEqual(duplicate.app.id, created.app.id);
    assert.equal(duplicate.draft.nodes.length, saved.draft.nodes.length);
    assert.equal(listWorkflows().length, 2);

    assert.equal(deleteWorkflow(duplicate.app.id), true);
    assert.equal(getWorkflow(duplicate.app.id), null);
    assert.equal(listWorkflows().length, 1);
  });

  it("publishes immutable snapshots and rolls the live pointer back", () => {
    const created = createWorkflow({ name: "Versioned" });
    const first = publishWorkflow({
      workflowId: created.app.id,
      expectedRevision: 1,
      releaseNotes: "first",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    });
    const changed = saveWorkflowDraft(created.app.id, 1, {
      ...created.draft,
      name: "Versioned draft two",
    });
    const second = publishWorkflow({
      workflowId: created.app.id,
      expectedRevision: changed.app.draftRevision,
      releaseNotes: "second",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    });

    assert.equal(first.versionNumber, 1);
    assert.equal(first.graph.name, "Versioned");
    assert.equal(second.versionNumber, 2);
    assert.equal(getWorkflow(created.app.id)?.app.currentVersionId, second.id);

    const rolledBack = rollbackWorkflow(created.app.id, first.id);
    assert.equal(rolledBack.app.currentVersionId, first.id);
    assert.equal(rolledBack.versions.length, 2);
  });

  it("claims idempotency keys once and retains the request hash", () => {
    const workflow = createWorkflow({ name: "Idempotent" });
    const first = claimWorkflowIdempotency({
      workflowId: workflow.app.id,
      idempotencyKey: "order-42",
      requestHash: "hash-a",
      runId: "run-a",
    });
    const second = claimWorkflowIdempotency({
      workflowId: workflow.app.id,
      idempotencyKey: "order-42",
      requestHash: "hash-b",
      runId: "run-b",
    });
    assert.deepEqual(first, { claimed: true, runId: "run-a" });
    assert.deepEqual(second, {
      claimed: false,
      runId: "run-a",
      requestHash: "hash-a",
    });
  });
});
