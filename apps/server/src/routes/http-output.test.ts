import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, it } from "node:test";
import { createApp } from "../app.js";
import { closeDb } from "../db.js";
import {
  createWorkflow,
  listWorkflowEvents,
  listWorkflowRuns,
  saveWorkflowDraft,
} from "../workflows/store.js";
import { executeWorkflow, type WorkflowEvent } from "../workflow/executor.js";
import { graphToRunNodes, type WorkflowGraph } from "../workflows/types.js";

let server: Server;
let fixture: Server;
let origin: string;
let fixtureOrigin: string;
let dir: string;
const oldPath = process.env.SQLITE_PATH;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), "http-output-routes-"));
  process.env.SQLITE_PATH = join(dir, "test.sqlite");
  closeDb();
  fixture = createServer((request, response) =>
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        authorization: request.headers.authorization,
        echoed: request.headers.authorization,
      }),
    ),
  ).listen(0, "127.0.0.1");
  server = createApp().listen(0, "127.0.0.1");
  await Promise.all([once(server, "listening"), once(fixture, "listening")]);
  const address = server.address();
  const fixtureAddress = fixture.address();
  assert.ok(
    address && typeof address === "object" && fixtureAddress && typeof fixtureAddress === "object",
  );
  origin = `http://127.0.0.1:${address.port}`;
  fixtureOrigin = `http://127.0.0.1:${fixtureAddress.port}`;
});
after(async () => {
  server.closeAllConnections();
  fixture.closeAllConnections();
  await Promise.all([
    new Promise<void>((resolve) => server.close(() => resolve())),
    new Promise<void>((resolve) => fixture.close(() => resolve())),
  ]);
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  if (oldPath === undefined) delete process.env.SQLITE_PATH;
  else process.env.SQLITE_PATH = oldPath;
});
const node = (
  id: string,
  kind: WorkflowGraph["nodes"][number]["data"]["kind"],
  config: Record<string, unknown> = {},
) => ({ id, data: { kind, label: id, config } });
const end = (id: string, result: string, unique: string) =>
  node(id, "end", {
    inputs: [
      { name: "value", source: { type: "literal", value: result } },
      { name: unique, source: { type: "literal", value: true } },
    ],
    outputs: [
      { name: "result", selector: "$inputs.value" },
      { name: unique, selector: `$inputs.${unique}` },
    ],
  });
const twoEnds = (): WorkflowGraph => ({
  name: "Ordered outputs",
  nodes: [
    node("s", "start", { runVariables: [], inputs: [], outputs: [] }),
    end("2", "later", "onlyLater"),
    node("a", "input", { inputs: [], outputs: [] }),
    node("b", "input", { inputs: [], outputs: [] }),
    end("10", "earlier", "onlyEarlier"),
  ],
  edges: [
    { source: "s", target: "a" },
    { source: "s", target: "b" },
    { source: "a", target: "10" },
    { source: "b", target: "2" },
  ],
});
const expected = { result: "later", onlyEarlier: true, onlyLater: true };
async function json(path: string, method = "GET", body?: unknown, token?: string) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.ok(response.ok, `${path}: ${response.status} ${response.ok ? "" : await response.text()}`);
  return response.json();
}

it("returns flat end outputs in blocking/public SSE and Studio SSE while persisting complete node events", async () => {
  const workflow = createWorkflow({ name: "Ordered outputs" });
  const graph = twoEnds();
  saveWorkflowDraft(workflow.app.id, 1, graph);
  await json(`/api/workflows/${workflow.app.id}/publish`, "POST", { expectedRevision: 2 });
  const key = (await json(`/api/workflows/${workflow.app.id}/api-keys`, "POST", {
    name: "test",
    rateLimitPerMinute: 100,
  })) as { rawKey: string };
  const blocking = (await json(
    `/v1/workflows/${workflow.app.slug}/run`,
    "POST",
    { inputs: {}, user: "tester" },
    key.rawKey,
  )) as { data: { outputs: Record<string, unknown> } };
  assert.deepEqual(blocking.data.outputs, expected);
  const publicSse = await fetch(`${origin}/v1/workflows/${workflow.app.slug}/run`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key.rawKey}` },
    body: JSON.stringify({ inputs: {}, user: "tester", response_mode: "streaming" }),
  });
  const publicEvents = (await publicSse.text())
    .split("\n\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
  assert.deepEqual(
    publicEvents.find((event) => event.event === "workflow_finished").data.outputs,
    expected,
  );
  assert.equal(publicEvents.filter((event) => event.event === "node_finished").length, 5);
  const studio = await fetch(`${origin}/api/workflow/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workflowId: workflow.app.id,
      nodes: graphToRunNodes(graph),
      edges: graph.edges,
      input: {},
    }),
  });
  const studioEvents = (await studio.text())
    .split("\n\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
  const done = studioEvents.find((event) => event.type === "run_done");
  assert.deepEqual(done.outputs, expected);
  assert.equal(Object.keys(done.nodeOutputs).length, 5);
  assert.equal(done.nodeOutputs["10"].result, "earlier");
  assert.equal(done.nodeOutputs["2"].result, "later");
  const run = listWorkflowRuns(workflow.app.id).find((run) => run.source === "studio")!;
  assert.deepEqual(run.outputs, expected);
  assert.equal(
    listWorkflowEvents(run.id).filter((event) => event.type === "node_finished").length,
    5,
  );
});

it("excludes condition branches that did not execute from final outputs", async () => {
  const graph: WorkflowGraph = {
    name: "Branch outputs",
    nodes: [
      node("s", "start", { runVariables: [], inputs: [], outputs: [] }),
      node("c", "condition", { expression: "true", inputs: [], outputs: [] }),
      end("yes", "selected", "yesOnly"),
      end("no", "skipped", "noOnly"),
    ],
    edges: [
      { source: "s", target: "c" },
      { source: "c", target: "yes", label: "true" },
      { source: "c", target: "no", label: "false" },
    ],
  };
  const events: WorkflowEvent[] = [];
  await executeWorkflow({ nodes: graphToRunNodes(graph), edges: graph.edges, input: {} }, (event) =>
    events.push(event),
  );
  assert.deepEqual(events.find((event) => event.type === "run_done")?.outputs, {
    result: "selected",
    yesOnly: true,
  });
  assert.equal(
    events.some((event) => event.nodeId === "no"),
    false,
  );
});

it("redacts HTTP credential echoes in persisted events, final Studio outputs and node snapshots", async () => {
  const workflow = createWorkflow({ name: "HTTP secret history" });
  const graph: WorkflowGraph = {
    name: workflow.app.name,
    nodes: [
      node("s", "start", {
        runVariables: [{ name: "credential", type: "string", required: true }],
        inputs: [],
        outputs: [],
      }),
      node("h", "http", {
        url: fixtureOrigin,
        inputs: [{ name: "token", source: { type: "run", variable: "credential" } }],
        authorization: { type: "bearer", config: { token: "{{token}}" } },
        outputs: [{ name: "body", selector: "$result.body" }],
      }),
      node("e", "end", {
        inputs: [{ name: "response", source: { type: "node", nodeId: "h", output: "body" } }],
        outputs: [{ name: "result", selector: "$inputs.response" }],
      }),
    ],
    edges: [
      { source: "s", target: "h" },
      { source: "h", target: "e" },
    ],
  };
  const response = await fetch(`${origin}/api/workflow/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workflowId: workflow.app.id,
      nodes: graphToRunNodes(graph),
      edges: graph.edges,
      input: { credential: "private-runtime-credential" },
    }),
  });
  const text = await response.text();
  assert.equal(text.includes("private-runtime-credential"), false);
  assert.match(text, /REDACTED/);
  const run = listWorkflowRuns(workflow.app.id)[0]!;
  assert.equal(run.status, "succeeded");
  assert.equal(JSON.stringify(run.outputs).includes("private-runtime-credential"), false);
  assert.equal(
    JSON.stringify(listWorkflowEvents(run.id)).includes("private-runtime-credential"),
    false,
  );
  const listed = (await json(`/api/workflows/${workflow.app.id}/runs`)) as {
    runs: Array<{ inputs: unknown }>;
  };
  assert.equal(JSON.stringify(listed.runs).includes("private-runtime-credential"), false);
  const history = (await json(`/api/workflows/${workflow.app.id}/runs/${run.id}/events`)) as {
    run: unknown;
    events: unknown;
  };
  assert.equal(
    JSON.stringify({ run: history.run, events: history.events }).includes(
      "private-runtime-credential",
    ),
    false,
  );
});

it("creates imported HTTP drafts without fixed credentials while keeping execution and publication gated", async () => {
  const graph: WorkflowGraph = {
    name: "Imported HTTP draft",
    nodes: [
      node("s", "start", { runVariables: [], inputs: [], outputs: [] }),
      node("h", "http", {
        url: fixtureOrigin,
        inputs: [],
        authorization: { type: "bearer", config: { token: "" } },
        outputs: [{ name: "body", selector: "$result.body" }],
      }),
      node("e", "end", {
        inputs: [{ name: "response", source: { type: "node", nodeId: "h", output: "body" } }],
        outputs: [{ name: "result", selector: "$inputs.response" }],
      }),
    ],
    edges: [
      { source: "s", target: "h" },
      { source: "h", target: "e" },
    ],
  };
  const created = (await json("/api/workflows", "POST", { name: graph.name, graph })) as {
    workflow: { app: { id: string } };
  };
  const id = created.workflow.app.id;
  for (const path of [
    `/api/workflows/${id}/publish`,
    `/api/workflows/${id}/validate`,
    "/api/workflow/run",
  ]) {
    const response = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 1,
        workflowId: id,
        nodes: graphToRunNodes(graph),
        edges: graph.edges,
        input: {},
      }),
    });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /HTTP 认证/);
  }
  graph.nodes[1]!.data.config!.authorization = {
    type: "bearer",
    config: { token: "reentered-fixture" },
  };
  saveWorkflowDraft(id, 1, graph);
  await json(`/api/workflows/${id}/publish`, "POST", { expectedRevision: 2 });
});
