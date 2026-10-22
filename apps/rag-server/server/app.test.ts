import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type {
  ChunkInfo,
  DocumentInfo,
  GraphAugmentation,
  IngestResult,
  ScoredChunk,
} from "@open-agent-tools/rag";
import { createApp } from "./app.js";
import { readServerConfig } from "./config.js";
import { createRuntime } from "./runtime.js";

const admin = { authorization: "Bearer admin" };
const runtimeHeaders = { authorization: "Bearer runtime", "content-type": "application/json" };
const content = "腾讯云，微信支付，小程序生态。腾讯云，云服务器，对象存储。";

interface QueryPayload {
  queryId: string;
  chunks: ScoredChunk[];
  graph: GraphAugmentation;
  retrieval: { graphEnabled: boolean };
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function startApp(t: TestContext, env: NodeJS.ProcessEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rag-app-"));
  const config = readServerConfig({
    RAG_STORE: "sqlite",
    RAG_DB_PATH: join(dir, "rag.db"),
    RAG_GRAPH_DB_PATH: join(dir, "graph.db"),
    RAG_RUNTIME_TOKEN: "runtime",
    RAG_ADMIN_TOKEN: "admin",
    ...env,
  });
  const runtime = createRuntime(config);
  const server = createApp(config, runtime).listen(0, "127.0.0.1");
  t.after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { origin: `http://127.0.0.1:${address.port}`, runtime };
}

test("the assembled HTTP app preserves upload, graph, audit and delete contracts for percent filenames", async (t) => {
  const { origin, runtime } = await startApp(t);
  const source = "研发 100%.md";
  const path = encodeURIComponent(source);
  const form = new FormData();
  form.append("files", new Blob([content]), source);
  const uploaded = await fetch(`${origin}/api/documents`, {
    method: "POST",
    headers: admin,
    body: form,
  });
  assert.equal(uploaded.status, 201, await uploaded.clone().text());
  assert.deepEqual((await json<IngestResult>(uploaded)).sources, [source]);
  await runtime.knowledge.waitIdle();

  const documents = await fetch(`${origin}/api/documents`, { headers: admin });
  const catalog = await json<{ sources: DocumentInfo[]; chunks: number }>(documents);
  assert.equal(catalog.sources[0]?.source, source);
  assert.equal(catalog.chunks, catalog.sources[0]?.chunks);
  const chunks = await fetch(`${origin}/api/documents/${path}/chunks`, { headers: admin });
  assert.equal(chunks.status, 200);
  assert.ok((await json<{ chunks: ChunkInfo[] }>(chunks)).chunks.length > 0);
  const updated = await fetch(`${origin}/api/documents/${path}`, {
    method: "PATCH",
    headers: { ...admin, "content-type": "application/json" },
    body: JSON.stringify({ title: "研发资料", tags: ["云服务"] }),
  });
  assert.equal(updated.status, 200);
  assert.equal((await json<{ document: DocumentInfo }>(updated)).document.title, "研发资料");
  const graph = await fetch(`${origin}/api/graph/documents/${path}`, { headers: admin });
  assert.equal(graph.status, 200);
  assert.ok((await json<{ nodes: unknown[] }>(graph)).nodes.length > 0);

  const queried = await fetch(`${origin}/api/query`, {
    method: "POST",
    headers: runtimeHeaders,
    body: JSON.stringify({ query: "腾讯云", sources: [source], generate: false }),
  });
  assert.equal(queried.status, 200, await queried.clone().text());
  const result = await json<QueryPayload>(queried);
  assert.ok(result.graph.chunkHits > 0);
  assert.ok(result.chunks.some((chunk) => chunk.debug?.channels.includes("graph")));
  const trace = await fetch(`${origin}/api/query/${result.queryId}`, { headers: admin });
  assert.equal(
    (await json<{ detail: { trace: { graphEnabled: boolean } } }>(trace)).detail.trace.graphEnabled,
    true,
  );
  const feedback = await fetch(`${origin}/api/query/${result.queryId}/feedback`, {
    method: "PUT",
    headers: runtimeHeaders,
    body: JSON.stringify({ rating: "positive" }),
  });
  assert.equal(feedback.status, 200);
  for (const endpoint of [
    "analytics/overview",
    "analytics/quality-report",
    "eval/datasets",
    "usage/events",
  ]) {
    assert.equal((await fetch(`${origin}/api/${endpoint}`, { headers: admin })).status, 200);
  }

  const deleted = await fetch(`${origin}/api/documents/${path}`, {
    method: "DELETE",
    headers: admin,
  });
  assert.equal(deleted.status, 200);
  assert.ok((await json<{ graph: { entities: number } }>(deleted)).graph.entities > 0);
  assert.deepEqual(runtime.knowledge.graph.getStats(), { entities: 0, relations: 0 });
  assert.deepEqual(await runtime.knowledge.rag.listSources(), []);
});

test("RAG and graph routes enforce the same runtime ACL through the assembled middleware", async (t) => {
  const { origin, runtime } = await startApp(t);
  await runtime.knowledge.ingestBuffers([
    { name: "public.md", data: new TextEncoder().encode(content) },
    { name: "hr.md", data: new TextEncoder().encode("腾讯云，薪酬标准，员工考核。") },
  ]);
  await runtime.knowledge.rag.updateDocument("hr.md", { allowedGroups: ["hr"] });
  await runtime.knowledge.waitIdle();
  assert.equal((await fetch(`${origin}/api/health`)).status, 200);
  assert.equal((await fetch(`${origin}/api/documents`, { headers: runtimeHeaders })).status, 401);

  for (const endpoint of ["query", "graph/retrieve"]) {
    const request = (viewerGroups?: string[]) =>
      fetch(`${origin}/api/${endpoint}`, {
        method: "POST",
        headers: runtimeHeaders,
        body: JSON.stringify({ query: "腾讯云", sources: ["hr.md"], viewerGroups }),
      });
    const hidden = await request();
    assert.equal(hidden.status, 200);
    const hiddenBody = await json<{ chunks: unknown[]; seeds: unknown[] }>(hidden);
    assert.equal(endpoint === "query" ? hiddenBody.chunks.length : hiddenBody.seeds.length, 0);
    const visible = await request(["hr"]);
    assert.equal(visible.status, 200);
    const visibleBody = await json<{ chunks: unknown[]; seeds: unknown[] }>(visible);
    assert.ok(endpoint === "query" ? visibleBody.chunks.length > 0 : visibleBody.seeds.length > 0);
    assert.equal((await request(["*"])).status, 400);
  }
});

test("manual graph reconciliation and the retrieval switch remain independent", async (t) => {
  const { origin, runtime } = await startApp(t, {
    RAG_AUTO_EXTRACT: "false",
    RAG_GRAPH_RETRIEVAL: "false",
  });
  await runtime.knowledge.ingestBuffers([
    { name: "guide.md", data: new TextEncoder().encode(content) },
  ]);
  assert.deepEqual((await runtime.knowledge.status()).missing, ["guide.md"]);
  const reconciled = await fetch(`${origin}/api/graph/reconcile`, {
    method: "POST",
    headers: admin,
  });
  assert.equal(reconciled.status, 200);
  assert.equal((await json<{ status: { inSync: boolean } }>(reconciled)).status.inSync, true);
  const response = await fetch(`${origin}/api/query`, {
    method: "POST",
    headers: runtimeHeaders,
    body: JSON.stringify({ query: "腾讯云", graph: true }),
  });
  const result = await json<QueryPayload>(response);
  assert.equal(result.graph.enabled, false);
  assert.equal(result.retrieval.graphEnabled, false);
});
