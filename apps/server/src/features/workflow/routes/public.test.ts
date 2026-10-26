import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createApp } from "../../../app.js";
import { closeDb } from "../../../platform/db.js";

let server: Server;
let origin: string;
let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "workflow-routes-"));
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
  delete process.env.SQLITE_PATH;
});

describe("published workflow API", () => {
  let workflowId = "";
  let workflowSlug = "";
  let rawKey = "";

  it("creates, saves, validates, and publishes a workflow", async () => {
    const createdResponse = await fetch(`${origin}/api/workflows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Public Echo" }),
    });
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json()) as {
      workflow: { app: { id: string; slug: string; draftRevision: number }; draft: unknown };
    };
    workflowId = created.workflow.app.id;
    workflowSlug = created.workflow.app.slug;

    const validation = await fetch(`${origin}/api/workflows/${workflowId}/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(validation.status, 200);
    const validationBody = (await validation.json()) as {
      valid: boolean;
      inputSchema: { required: string[] };
      outputSchema: { properties: Record<string, unknown> };
    };
    assert.equal(validationBody.valid, true);
    assert.deepEqual(validationBody.inputSchema.required, ["query"]);
    assert.ok(validationBody.outputSchema.properties.result);

    const published = await fetch(`${origin}/api/workflows/${workflowId}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1, releaseNotes: "ready" }),
    });
    assert.equal(published.status, 201);

    const keyResponse = await fetch(`${origin}/api/workflows/${workflowId}/api-keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "test", rateLimitPerMinute: 100 }),
    });
    assert.equal(keyResponse.status, 201);
    rawKey = ((await keyResponse.json()) as { rawKey: string }).rawKey;
    assert.match(rawKey, /^wf\./);
  });

  it("rejects anonymous calls and runs the published snapshot in blocking mode", async () => {
    const anonymous = await fetch(`${origin}/v1/workflows/${workflowSlug}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inputs: { query: "hello" }, user: "u-1" }),
    });
    assert.equal(anonymous.status, 401);

    const response = await fetch(`${origin}/v1/workflows/${workflowSlug}/run`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${rawKey}`,
        "content-type": "application/json",
        "idempotency-key": "echo-1",
      },
      body: JSON.stringify({ inputs: { query: "hello" }, user: "u-1" }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      workflow_run_id: string;
      data: { status: string; outputs: Record<string, unknown> };
    };
    assert.equal(body.data.status, "succeeded");
    assert.deepEqual(body.data.outputs, { result: "hello" });

    const replay = await fetch(`${origin}/v1/workflows/${workflowSlug}/run`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${rawKey}`,
        "content-type": "application/json",
        "idempotency-key": "echo-1",
      },
      body: JSON.stringify({ inputs: { query: "hello" }, user: "u-1" }),
    });
    assert.equal(replay.status, 200);
    assert.equal(
      ((await replay.json()) as { workflow_run_id: string }).workflow_run_id,
      body.workflow_run_id,
    );
  });

  it("streams public events and exports an importable OpenAPI document", async () => {
    const response = await fetch(`${origin}/v1/workflows/${workflowSlug}/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${rawKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        inputs: { query: "stream me" },
        user: "u-2",
        response_mode: "streaming",
      }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const stream = await response.text();
    assert.match(stream, /"event":"workflow_started"/);
    assert.match(stream, /"event":"node_finished"/);
    assert.match(stream, /"event":"workflow_finished"/);
    assert.match(stream, /"result":"stream me"/);

    const openApiResponse = await fetch(`${origin}/api/workflows/${workflowId}/openapi.json`);
    assert.equal(openApiResponse.status, 200);
    const openApi = (await openApiResponse.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
      components: { securitySchemes: Record<string, unknown> };
    };
    assert.equal(openApi.openapi, "3.1.0");
    assert.ok(openApi.paths[`/v1/workflows/${workflowSlug}/run`]);
    assert.ok(openApi.components.securitySchemes.WorkflowApiKey);
  });
});

it("saves unfinished variable bindings as drafts but blocks their publication", async () => {
  const createdResponse = await fetch(`${origin}/api/workflows`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Unfinished Variables" }),
  });
  const { workflow } = (await createdResponse.json()) as {
    workflow: {
      app: { id: string };
      draft: { nodes: Array<{ data: { config: Record<string, unknown> } }> };
    };
  };
  workflow.draft.nodes[1]!.data.config.inputs = [
    { name: "query", source: { type: "run", variable: "qurey" } },
  ];
  const saved = await fetch(`${origin}/api/workflows/${workflow.app.id}/draft`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: 1, graph: workflow.draft }),
  });
  assert.equal(saved.status, 200);
  const published = await fetch(`${origin}/api/workflows/${workflow.app.id}/publish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: 2 }),
  });
  assert.equal(published.status, 400);
  assert.match(((await published.json()) as { error: string }).error, /qurey 未声明/);
});
