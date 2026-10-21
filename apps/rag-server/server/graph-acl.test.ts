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
import { graphRouter } from "./graph.js";
import { GraphLifecycle } from "./lifecycle.js";
import { resolveRagAuth } from "./auth.js";

let server: Server;
let origin: string;
let dir: string;
let rag: Rag;
let graph: KnowledgeGraph;

const silent = { log: () => undefined, error: () => undefined };

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "rag-graph-acl-"));
  rag = new Rag({ dbPath: join(dir, "rag.db") });
  graph = new KnowledgeGraph({ dbPath: join(dir, "graph.db") });
  const lifecycle = new GraphLifecycle({ rag, graph, logger: silent });

  await rag.ingestBuffers([
    {
      name: "public.md",
      data: new TextEncoder().encode("腾讯云，微信支付，小程序生态。"),
    },
    {
      name: "hr.md",
      data: new TextEncoder().encode("腾讯云，薪酬带宽，HR 制度。"),
    },
  ]);
  await rag.updateDocument("hr.md", { allowedGroups: ["hr"] });
  await lifecycle.onDocumentsIngested(["public.md", "hr.md"]);
  await lifecycle.waitIdle();

  const app = express();
  app.use(resolveRagAuth({ runtimeToken: "runtime-token", adminToken: "admin-token" }).middleware);
  app.use(express.json());
  app.use("/api/graph", graphRouter({ rag, graph, lifecycle }));
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  server.close();
  await once(server, "close");
  graph.close();
  await rag.close();
  rmSync(dir, { recursive: true, force: true });
});

async function retrieve(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${origin}/api/graph/retrieve`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer runtime-token",
    },
    body: JSON.stringify(body),
  });
}

describe("graph retrieve document ACL", () => {
  it("returns graph evidence only from public and authorized documents", async () => {
    const response = await retrieve({
      query: "腾讯云",
      sources: ["public.md", "hr.md"],
      viewerGroups: ["hr"],
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { formatted: string; seeds: Array<{ name: string }> };
    assert.ok(body.seeds.some((seed) => seed.name === "腾讯云"));
    assert.match(body.formatted, /微信支付/);
    assert.match(body.formatted, /薪酬带宽/);
  });

  it("does not return graph evidence from a document outside the viewer groups", async () => {
    const response = await retrieve({
      query: "腾讯云",
      sources: ["public.md", "hr.md"],
      viewerGroups: [],
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { formatted: string; seeds: Array<{ name: string }> };
    assert.ok(body.seeds.some((seed) => seed.name === "腾讯云"));
    assert.match(body.formatted, /微信支付/);
    assert.doesNotMatch(body.formatted, /薪酬带宽/);
  });

  it("defaults runtime requests without groups to public-only evidence", async () => {
    const response = await retrieve({ query: "腾讯云", sources: ["public.md", "hr.md"] });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { formatted: string };
    assert.match(body.formatted, /微信支付/);
    assert.doesNotMatch(body.formatted, /薪酬带宽/);
  });

  it("requires the runtime token for graph retrieval", async () => {
    const response = await fetch(`${origin}/api/graph/retrieve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "腾讯云" }),
    });
    assert.equal(response.status, 401);
  });
});

describe("document-scoped graph browsing", () => {
  const adminHeaders = { authorization: "Bearer admin-token" };

  it("exports only the selected document's entities and relationships", async () => {
    const response = await fetch(`${origin}/api/graph/documents/public.md`, { headers: adminHeaders });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      nodes: Array<{ id: string; name: string; props: Record<string, string> }>;
      edges: Array<{ source: string; target: string }>;
      stats: { entities: number; relations: number };
    };
    assert.ok(body.nodes.some((node) => node.name === "微信支付"));
    assert.ok(!body.nodes.some((node) => node.name === "薪酬带宽"));
    assert.equal(body.stats.entities, body.nodes.length);
    assert.equal(body.stats.relations, body.edges.length);
    const ids = new Set(body.nodes.map((node) => node.id));
    assert.ok(body.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target)));
    assert.ok(body.nodes.every((node) => node.props !== undefined));
  });

  it("does not let a shared entity expand into another document", async () => {
    const seed = graph.listEntities({ search: "腾讯云" })[0];
    assert.ok(seed);
    const response = await fetch(`${origin}/api/graph/neighbors/${seed.id}?hops=2&source=public.md`, {
      headers: adminHeaders,
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { nodes: Array<{ name: string }> };
    assert.ok(body.nodes.some((node) => node.name === "微信支付"));
    assert.ok(!body.nodes.some((node) => node.name === "薪酬带宽"));
  });

  it("rejects a missing document or an empty neighbor scope", async () => {
    const missing = await fetch(`${origin}/api/graph/documents/missing.md`, { headers: adminHeaders });
    assert.equal(missing.status, 404);
    const empty = await fetch(`${origin}/api/graph/neighbors/unknown?source=`, { headers: adminHeaders });
    assert.equal(empty.status, 400);
    const array = await fetch(`${origin}/api/graph/neighbors/unknown?source=public.md&source=hr.md`, { headers: adminHeaders });
    // An invalid selected source must never turn into a full-library lookup.
    assert.equal(array.status, 400);
  });

  it("keeps document graph exports admin-only", async () => {
    const response = await fetch(`${origin}/api/graph/documents/hr.md`, {
      headers: { authorization: "Bearer runtime-token" },
    });
    assert.equal(response.status, 401);
  });
});
