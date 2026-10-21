import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import express from "express";
import { Rag } from "@open-agent-tools/rag";
import { KnowledgeGraph } from "@open-agent-tools/rag/graph";
import { GraphLifecycle } from "./lifecycle.js";
import { RagUsageStore, ragUsageMiddleware, trackRagLlm } from "./usage.js";

let dir: string;
let server: Server;
let origin: string;
let store: RagUsageStore;
let rag: Rag;
let graph: KnowledgeGraph;
let lifecycle: GraphLifecycle;
let releaseGraph!: () => void;
const graphGate = new Promise<void>((resolve) => {
  releaseGraph = resolve;
});

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "rag-usage-test-"));
  store = new RagUsageStore(join(dir, "usage.sqlite"));
  rag = new Rag({ dbPath: join(dir, "rag.sqlite") });
  graph = new KnowledgeGraph({
    dbPath: join(dir, "graph.sqlite"),
    llmChat: async () => {
      await graphGate;
      await trackRagLlm("rag_graph", "graph-model", async () => ({
        usage_metadata: { input_tokens: 40, output_tokens: 10 },
      }));
      return '{"entities":[],"relations":[]}';
    },
  });
  lifecycle = new GraphLifecycle({ rag, graph, logger: { log() {}, error() {} } });
  await rag.ingestBuffers([
    { name: "a.md", data: new TextEncoder().encode("Alpha graph source") },
    { name: "b.md", data: new TextEncoder().encode("Beta graph source") },
  ]);
  const app = express();
  app.use(express.json());
  app.use(ragUsageMiddleware(store));
  app.post("/api/query", async (req, res) => {
    if (req.body.generate === false) {
      res.json({ answer: null });
      return;
    }
    try {
      await trackRagLlm("rag_query", "answer-model", async () => {
        if (req.body.fail) throw new Error("model failed");
        return req.body.fallback
          ? { response_metadata: { tokenUsage: { promptTokens: 30, completionTokens: 7 } } }
          : { usage_metadata: { input_tokens: 20, output_tokens: 5 } };
      });
      res.json({ answer: "ok" });
    } catch {
      res.status(500).json({ error: "model failed" });
    }
  });
  app.post("/api/documents", async (req, res) => {
    await lifecycle.onDocumentsIngested([req.body.source]);
    res.status(201).json({ ok: true });
  });
  app.get("/api/graph/sync-status", async (_req, res) => res.json(await lifecycle.status()));
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  releaseGraph();
  await lifecycle.waitIdle();
  server.close();
  await once(server, "close");
  store.close();
  await rag.close();
  graph.close();
  rmSync(dir, { recursive: true, force: true });
});

async function query(body: Record<string, unknown>) {
  return fetch(`${origin}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-workspace-id": "qa" },
    body: JSON.stringify(body),
  });
}

describe("RAG usage metering", () => {
  it("returns actual generation tokens and the fallback token metadata", async () => {
    const response = await query({});
    const body = (await response.json()) as { usage: { requests: number; totalTokens: number } };
    assert.equal(body.usage.requests, 1);
    assert.equal(body.usage.totalTokens, 25);
    const fallback = (await (await query({ fallback: true })).json()) as typeof body;
    assert.equal(fallback.usage.totalTokens, 37);
  });

  it("counts failed model calls and reports zero requests for retrieval without generation", async () => {
    const failed = await query({ fail: true });
    assert.equal(failed.status, 500);
    const failure = (await failed.json()) as { usage: { requests: number; totalTokens: number } };
    assert.equal(failure.usage.requests, 1);
    assert.equal(failure.usage.totalTokens, 0);
    assert.equal(store.events(0).events.at(-1)?.status, "error");
    const retrieval = (await (await query({ generate: false })).json()) as typeof failure;
    assert.equal(retrieval.usage.requests, 0);
  });

  it("keeps queued background graph calls in the workspace of each upload", async () => {
    for (const [workspaceId, source] of [
      ["team-a", "a.md"],
      ["team-b", "b.md"],
    ]) {
      const response = await fetch(`${origin}/api/documents`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-workspace-id": workspaceId! },
        body: JSON.stringify({ source }),
      });
      assert.equal(response.status, 201);
    }
    assert.equal(
      store.events(0).events.some((event) => event.source === "rag_graph"),
      false,
    );
    releaseGraph();
    await lifecycle.waitIdle();
    const events = store.events(0).events.filter((event) => event.source === "rag_graph");
    assert.deepEqual(
      events.map((event) => event.workspaceId),
      ["team-a", "team-b"],
    );
    assert.ok(events.every((event) => event.inputTokens + event.outputTokens === 50));
    for (const workspaceId of ["team-a", "team-b"]) {
      const response = await fetch(`${origin}/api/graph/sync-status`, {
        headers: { "x-workspace-id": workspaceId },
      });
      const body = (await response.json()) as { usage: { requests: number; totalTokens: number } };
      assert.equal(body.usage.requests, 1);
      assert.equal(body.usage.totalTokens, 50);
    }
  });

  it("paginates the durable outbox without losing events that share timestamps", () => {
    const first = store.events(0, 2);
    assert.equal(first.events.length, 2);
    assert.equal(first.hasMore, true);
    const rest = store.events(first.nextCursor);
    assert.ok(rest.events.every((event) => !first.events.some((seen) => seen.id === event.id)));
    assert.equal(rest.hasMore, false);
    assert.deepEqual(store.events(rest.nextCursor).events, []);
  });
});
