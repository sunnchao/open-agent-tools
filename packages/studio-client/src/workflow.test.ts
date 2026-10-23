import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWorkflowClient } from "./workflow.js";

describe("shared workflow management client", () => {
  it("preserves scoped routes, JSON bodies, response envelopes and cancellation", async () => {
    const graph = { name: "工作流", nodes: [], edges: [] };
    const workflow = { app: { id: "wf" }, draft: graph, versions: [] };
    const signal = new AbortController().signal;
    const root = "/api/workflows/%E5%B7%A5%E4%BD%9C%E6%B5%81%2Fa%20b";
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const payloads = [
      { workflows: [workflow.app] },
      { workflow, apiKeys: [] },
      { workflow },
      { workflow },
      null,
      { workflow },
      { workflow },
      { workflow },
      { key: { id: "key" }, rawKey: "wf.secret" },
      null,
      { runs: [{ id: "run" }] },
      { run: { id: "run" }, events: [], graph },
    ];
    const client = createWorkflowClient(async (path, init) => {
      calls.push({ path, init });
      const payload = payloads.shift();
      assert.notEqual(payload, undefined);
      return payload === null ? new Response(null, { status: 204 }) : Response.json(payload);
    });
    const id = "工作流/a b";
    assert.deepEqual(await client.fetchWorkflows(), [workflow.app]);
    assert.deepEqual(await client.fetchWorkflow(id), { workflow, apiKeys: [] });
    assert.deepEqual(await client.createWorkflow({ name: "工作流", graph }), workflow);
    assert.deepEqual(await client.duplicateWorkflow(id), workflow);
    assert.equal(await client.deleteWorkflow(id), undefined);
    assert.deepEqual(await client.saveWorkflowDraft(id, 0, graph), workflow);
    assert.deepEqual(await client.publishWorkflow(id, 1), workflow);
    assert.deepEqual(await client.rollbackWorkflow(id, "版本/1"), workflow);
    assert.deepEqual(await client.createWorkflowKey(id, { name: "key", rateLimitPerMinute: 3 }), {
      key: { id: "key" },
      rawKey: "wf.secret",
    });
    assert.equal(await client.revokeWorkflowKey(id, "key/1"), undefined);
    assert.deepEqual(await client.fetchWorkflowRuns(id, signal), [{ id: "run" }]);
    assert.deepEqual(await client.fetchWorkflowRunEvents(id, "run/1", signal), {
      run: { id: "run" },
      events: [],
      graph,
    });
    assert.equal(payloads.length, 0);
    assert.deepEqual(
      calls.map(({ path, init }) => [path, init?.method ?? "GET"]),
      [
        ["/api/workflows", "GET"],
        [root, "GET"],
        ["/api/workflows", "POST"],
        [`${root}/duplicate`, "POST"],
        [root, "DELETE"],
        [`${root}/draft`, "PUT"],
        [`${root}/publish`, "POST"],
        [`${root}/rollback`, "POST"],
        [`${root}/api-keys`, "POST"],
        [`${root}/api-keys/key%2F1`, "DELETE"],
        [`${root}/runs`, "GET"],
        [`${root}/runs/run%2F1/events`, "GET"],
      ],
    );
    const expectedBodies = new Map([
      [2, { name: "工作流", graph }],
      [5, { expectedRevision: 0, graph }],
      [6, { expectedRevision: 1, releaseNotes: "" }],
      [7, { versionId: "版本/1" }],
      [8, { name: "key", rateLimitPerMinute: 3 }],
    ]);
    for (const [index, body] of expectedBodies) {
      assert.equal(
        new Headers(calls[index]!.init?.headers).get("content-type"),
        "application/json",
      );
      assert.deepEqual(JSON.parse(String(calls[index]!.init?.body)), body);
    }
    assert.deepEqual(calls[3]!.init, { method: "POST" });
    assert.equal(calls[10]!.init?.signal, signal);
    assert.equal(calls[11]!.init?.signal, signal);
  });

  it("retains deletion idempotency, conflicts and invalid-JSON fallbacks", async () => {
    const responses = [
      new Response("not found", { status: 404 }),
      new Response("not found", { status: 404 }),
      Response.json({ error: "workflow draft changed" }, { status: 409 }),
      new Response("bad gateway", { status: 502 }),
      Response.json({ error: "workflow run not found" }, { status: 404 }),
      new Response("not JSON"),
    ];
    const client = createWorkflowClient(async () => {
      const response = responses.shift();
      assert.ok(response);
      return response;
    });
    await client.deleteWorkflow("missing");
    await client.revokeWorkflowKey("workflow", "missing");
    await assert.rejects(
      client.saveWorkflowDraft("workflow", 1, { name: "", nodes: [], edges: [] }),
      /workflow draft changed/,
    );
    await assert.rejects(client.deleteWorkflow("workflow"), /HTTP 502/);
    await assert.rejects(
      client.fetchWorkflowRunEvents("workflow", "missing"),
      /workflow run not found/,
    );
    assert.deepEqual(await client.fetchWorkflow("workflow"), {});
  });

  it("propagates transport aborts without converting them to HTTP errors", async () => {
    const client = createWorkflowClient(async () => {
      throw new DOMException("cancelled", "AbortError");
    });
    await assert.rejects(client.fetchWorkflowRuns("workflow"), { name: "AbortError" });
  });

  it("keeps serialization and malformed-ID failures as rejected promises", async () => {
    const client = createWorkflowClient<unknown>(async () => {
      throw new Error("unexpected request");
    });
    const graph: Record<string, unknown> = {};
    graph.self = graph;
    const pending = client.createWorkflow({ name: "cycle", graph });
    assert.ok(pending instanceof Promise);
    await assert.rejects(pending, { name: "TypeError" });
    const malformedId = client.fetchWorkflow("\uD800");
    assert.ok(malformedId instanceof Promise);
    await assert.rejects(malformedId, { name: "URIError" });
  });
});
