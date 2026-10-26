import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, it } from "node:test";
import { createApp } from "../../../app.js";
import { closeDb, openDb } from "../../../platform/db.js";
import {
  createWorkflow,
  getWorkflow,
  listWorkflowRuns,
  listWorkflowEvents,
  saveWorkflowDraft,
  deleteWorkflow,
  getWorkflowRunSnapshot,
} from "../library/store.js";
import { startPublishedWorkflow } from "../library/runtime.js";
import type { WorkflowGraph } from "../library/types.js";

let server: Server;
let origin: string;
let dir: string;
const oldPath = process.env.SQLITE_PATH;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), "workflow-history-"));
  process.env.SQLITE_PATH = join(dir, "test.sqlite");
  closeDb();
  server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  server.close();
  await once(server, "close");
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  if (oldPath === undefined) delete process.env.SQLITE_PATH;
  else process.env.SQLITE_PATH = oldPath;
});

it("persists Studio runs without publishing, emits nodes once, and replays immutable snapshots", async () => {
  const workflow = createWorkflow({ name: "Studio history" });
  const response = await fetch(`${origin}/api/workflow/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workflowId: workflow.app.id,
      nodes: workflow.draft.nodes.map((node) => ({
        id: node.id,
        kind: node.data.kind,
        label: node.data.label,
        config: node.data.config,
      })),
      edges: workflow.draft.edges,
      input: { query: "first" },
    }),
  });
  assert.equal(response.status, 200);
  const events = (await response.text())
    .split("\n\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as { type: string; nodeId?: string });
  assert.equal(events.filter((event) => event.type === "node_start").length, 3);
  assert.equal(events.filter((event) => event.type === "node_result").length, 3);
  assert.equal(events.filter((event) => event.type === "run_done").length, 1);
  const run = listWorkflowRuns(workflow.app.id)[0]!;
  assert.equal(run.status, "succeeded");
  assert.equal(run.versionId, null);
  assert.equal(run.source, "studio");
  assert.deepEqual(run.outputs, { result: "first" });
  assert.equal(getWorkflow(workflow.app.id)?.versions.length, 0);
  saveWorkflowDraft(workflow.app.id, 1, { ...workflow.draft, name: "Changed draft" });
  const detailResponse = await fetch(
    `${origin}/api/workflows/${workflow.app.id}/runs/${run.id}/events`,
  );
  assert.equal(detailResponse.status, 200);
  const detail = (await detailResponse.json()) as { graph: WorkflowGraph; events: unknown[] };
  assert.equal(detail.graph.name, "Studio history");
  assert.equal(detail.events.length, 8);
  closeDb();
  assert.equal(listWorkflowRuns(workflow.app.id)[0]?.id, run.id);
  assert.equal(getWorkflowRunSnapshot(run.id)?.name, "Studio history");
  const other = createWorkflow({ name: "Other" });
  assert.equal(
    (await fetch(`${origin}/api/workflows/${other.app.id}/runs/${run.id}/events`)).status,
    404,
  );
  assert.equal(
    (await fetch(`${origin}/api/workflows/${workflow.app.id}/runs/${run.id}/events?after=-1`))
      .status,
    400,
  );
  assert.equal((await fetch(`${origin}/v1/workflow-runs/${run.id}/events`)).status, 401);
  deleteWorkflow(workflow.app.id);
  assert.equal(
    (await fetch(`${origin}/api/workflows/${workflow.app.id}/runs/${run.id}/events`)).status,
    404,
  );
});

it("persists failed and stopped runs and their terminal events", async () => {
  const workflow = createWorkflow({ name: "Failure history" });
  const failed = startPublishedWorkflow({
    app: workflow.app,
    graph: workflow.draft,
    inputs: {},
    user: "studio",
    source: "studio",
  });
  assert.equal((await failed.completion).status, "failed");
  assert.equal(listWorkflowRuns(workflow.app.id)[0]?.status, "failed");
  assert.equal(listWorkflowEvents(failed.runId).at(-1)?.type, "error");
  const controller = new AbortController();
  controller.abort();
  const stopped = startPublishedWorkflow({
    app: workflow.app,
    graph: workflow.draft,
    inputs: { query: "cancel" },
    user: "studio",
    source: "studio",
    signal: controller.signal,
  });
  assert.equal((await stopped.completion).status, "stopped");
  assert.equal(listWorkflowEvents(stopped.runId).at(-1)?.payload.status, "stopped");
});

it("rejects unknown kinds and malformed configurations before updating a draft", async () => {
  const workflow = createWorkflow({ name: "Schema validation" });
  for (const change of [{ kind: "unknown" }, { config: { runVariables: "invalid" } }]) {
    const graph = structuredClone(workflow.draft);
    Object.assign(graph.nodes[0]!.data, change);
    const response = await fetch(`${origin}/api/workflows/${workflow.app.id}/draft`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1, graph }),
    });
    assert.equal(response.status, 400);
    assert.equal(getWorkflow(workflow.app.id)?.app.draftRevision, 1);
  }
});

it("resumes from server-held snapshots, persists reuse metadata, and rejects stale or foreign caches", async () => {
  const workflow = createWorkflow({ name: "Resume history" });
  const original = startPublishedWorkflow({
    app: workflow.app,
    graph: workflow.draft,
    inputs: { query: "original" },
    user: "studio",
    source: "studio",
  });
  await original.completion;
  const body = {
    workflowId: workflow.app.id,
    nodes: workflow.draft.nodes.map((node) => ({
      id: node.id,
      kind: node.data.kind,
      config: node.data.config,
    })),
    edges: workflow.draft.edges,
    input: { query: "untrusted replacement" },
    resume: { runId: original.runId, fromNodeId: "end-1" },
  };
  const response = await fetch(`${origin}/api/workflow/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /node_cached/);
  const run = listWorkflowRuns(workflow.app.id).find((run) => run.id !== original.runId)!;
  assert.deepEqual(run.outputs, { result: "original" });
  assert.equal(run.totalSteps, 1);
  assert.deepEqual(run.inputs, { query: "original" });
  assert.equal(
    listWorkflowEvents(run.id).filter((event) => event.type === "node_started").length,
    1,
  );
  assert.equal(listWorkflowEvents(run.id)[0]?.payload.resume_run_id, original.runId);
  body.nodes[1]!.config = { ...body.nodes[1]!.config, required: false };
  assert.equal(
    (
      await fetch(`${origin}/api/workflow/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    ).status,
    400,
  );
  body.workflowId = createWorkflow({ name: "Other resume" }).app.id;
  assert.equal(
    (
      await fetch(`${origin}/api/workflow/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    ).status,
    404,
  );
});

it("migrates legacy NOT NULL version_id without losing child events or snapshots", async () => {
  const workflow = createWorkflow({ name: "Legacy migration" });
  const finished = startPublishedWorkflow({
    app: workflow.app,
    graph: workflow.draft,
    inputs: { query: "legacy" },
    user: "studio",
    source: "studio",
  });
  await finished.completion;
  const db = openDb();
  // Simulate a legacy constraint with a real published version for the existing run.
  const { publishWorkflow } = await import("../library/store.js");
  const version = publishWorkflow({
    workflowId: workflow.app.id,
    expectedRevision: 1,
    inputSchema: {},
    outputSchema: {},
  });
  db.prepare("UPDATE workflow_runs SET version_id = ? WHERE version_id IS NULL").run(version.id);
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'workflow_runs'").get() as {
    sql: string;
  };
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  db.exec(
    schema.sql
      .replace("workflow_runs", "workflow_runs_legacy")
      .replace(/version_id\s+TEXT/, "version_id TEXT NOT NULL"),
  );
  db.exec(
    "INSERT INTO workflow_runs_legacy SELECT * FROM workflow_runs; DROP TABLE workflow_runs; ALTER TABLE workflow_runs_legacy RENAME TO workflow_runs; COMMIT;",
  );
  db.exec("PRAGMA foreign_keys = ON");
  assert.equal(listWorkflowRuns(workflow.app.id)[0]?.id, finished.runId);
  assert.equal(listWorkflowEvents(finished.runId).length, 8);
  assert.equal(getWorkflowRunSnapshot(finished.runId)?.name, "Legacy migration");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  const newRun = startPublishedWorkflow({
    app: workflow.app,
    graph: workflow.draft,
    inputs: { query: "new" },
    user: "studio",
    source: "studio",
  });
  assert.equal((await newRun.completion).status, "succeeded");
});
