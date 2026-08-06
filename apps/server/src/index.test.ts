import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { closeDb } from "./db.js";
import { createProvider } from "./providers/store.js";

let server: Server;
let origin: string;
let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "server-contract-test-"));
  process.env.NODE_ENV = "test";
  process.env.SQLITE_PATH = join(dir, "test.sqlite");
  process.env.PROVIDER_KEYS_ENCRYPTION_KEY =
    "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
  const { app } = await import("./index.js");
  // Provider 不再由环境变量注入，测试需显式 seed 一个默认 Provider。
  createProvider({
    id: "default",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o-mini"],
    enabled: true,
  });
  server = app.listen(0, "127.0.0.1");
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
});

describe("server provider and workflow contracts", () => {
  it("returns masked provider metadata and supports admin CRUD", async () => {
    const initial = (await fetch(`${origin}/api/providers`).then((response) =>
      response.json(),
    )) as { providers: Array<Record<string, unknown>> };
    assert.equal(initial.providers[0]?.id, "default");
    assert.equal("apiKey" in initial.providers[0]!, false);

    const createdResponse = await fetch(`${origin}/api/admin/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Local",
        baseUrl: "http://localhost:11434/v1",
        models: ["llama3"],
        enabled: true,
      }),
    });
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json()) as { provider: { id: string } };
    const removed = await fetch(`${origin}/api/admin/providers/${created.provider.id}`, {
      method: "DELETE",
    });
    assert.equal(removed.status, 204);
  });

  it("rejects an unknown chat provider before making an LLM request", async () => {
    const response = await fetch(`${origin}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providerId: "missing",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "provider not found" });
  });

  it("returns validation errors as JSON and valid workflow events as SSE", async () => {
    const invalid = await fetch(`${origin}/api/workflow/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nodes: [{ id: "a", kind: "start" }],
        edges: [{ source: "a", target: "a" }],
        input: {},
      }),
    });
    assert.equal(invalid.status, 400);

    const valid = await fetch(`${origin}/api/workflow/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        nodes: [{ id: "a", kind: "start", label: "Start" }],
        edges: [],
        input: {},
      }),
    });
    assert.equal(valid.status, 200);
    assert.match(valid.headers.get("content-type") ?? "", /text\/event-stream/);
    const body = await valid.text();
    assert.match(body, /"type":"node_start"/);
    assert.match(body, /"type":"run_done"/);
  });

  it("tests one workflow node and returns its observable execution details", async () => {
    const response = await fetch(`${origin}/api/workflow/node/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        node: {
          id: "input-1",
          kind: "input",
          config: {
            inputs: [{ name: "text", source: { type: "run", variable: "text" } }],
            outputs: [{ name: "text", selector: "$result.text" }],
          },
        },
        inputs: { text: "hello" },
      }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      result: {
        status: string;
        inputs: Record<string, unknown>;
        result: unknown;
        outputs: Record<string, unknown>;
        metadata: { nodeKind: string; durationMs: number };
      };
    };
    assert.equal(body.result.status, "success");
    assert.deepEqual(body.result.inputs, { text: "hello" });
    assert.deepEqual(body.result.result, { text: "hello" });
    assert.deepEqual(body.result.outputs, { text: "hello" });
    assert.equal(body.result.metadata.nodeKind, "input");
    assert.ok(body.result.metadata.durationMs >= 0);
  });
});
