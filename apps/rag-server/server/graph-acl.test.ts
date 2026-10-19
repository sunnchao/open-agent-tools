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
  rag.updateDocument("hr.md", { allowedGroups: ["hr"] });
  lifecycle.onDocumentsIngested(["public.md", "hr.md"]);
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
  rag.close();
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
