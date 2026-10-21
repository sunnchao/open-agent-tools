import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import express from "express";
import { createApp } from "./app.js";
import { closeDb, openDb } from "./db.js";
import { syncRagUsage } from "./ragUsage.js";
import {
  listRecentUsage,
  summarizeUsage,
  type UsageEventInput,
  type UsageSummary,
} from "./usage.js";
import { createWorkspace } from "./workspace.js";

let dir: string;
let upstream: Server;
let server: Server;
let origin: string;
let workspaceId: string;
let unavailable = false;
let invalid = false;
let authorized = false;
let requests = 0;
const previousEnv = {
  SQLITE_PATH: process.env.SQLITE_PATH,
  RAG_API_URL: process.env.RAG_API_URL,
  RAG_ADMIN_TOKEN: process.env.RAG_ADMIN_TOKEN,
};
const events: Array<UsageEventInput & { id: string; createdAt: number; sequence: number }> = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "rag-usage-sync-test-"));
  process.env.SQLITE_PATH = join(dir, "usage.sqlite");
  process.env.RAG_ADMIN_TOKEN = "rag-usage-admin";
  workspaceId = createWorkspace({ name: "Graph team" }).id;
  const createdAt = Date.now() - 100;
  events.push(
    {
      sequence: 1,
      id: "answer-1",
      kind: "chat",
      source: "rag_query",
      model: "answer-model",
      requests: 1,
      inputTokens: 20,
      outputTokens: 5,
      workspaceId: "default",
      createdAt,
    },
    {
      sequence: 2,
      id: "graph-1",
      kind: "chat",
      source: "rag_graph",
      model: "graph-model",
      requests: 1,
      inputTokens: 40,
      outputTokens: 10,
      workspaceId,
      createdAt,
    },
  );
  const app = express();
  app.get("/api/usage/events", (req, res) => {
    requests += 1;
    authorized = req.header("authorization") === "Bearer rag-usage-admin";
    if (unavailable) {
      res.status(503).json({ error: "unavailable" });
      return;
    }
    const cursor = Number(req.query.after ?? 0);
    // Return a single event per page to exercise sequence cursors and atomic imports.
    const remaining = events.filter((event) => event.sequence > cursor);
    const visible = remaining.slice(0, 1);
    res.json({
      events: invalid ? [{ ...visible[0], source: "invalid" }] : visible,
      nextCursor: visible.at(-1)?.sequence ?? cursor,
      hasMore: remaining.length > visible.length,
    });
  });
  upstream = app.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  process.env.RAG_API_URL = `http://127.0.0.1:${address.port}/api`;
  server = createApp({ studioAuth: { token: "studio-usage-token" } }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const serverAddress = server.address();
  assert.ok(serverAddress && typeof serverAddress === "object");
  origin = `http://127.0.0.1:${serverAddress.port}`;
});

after(async () => {
  server.close();
  await once(server, "close");
  upstream.close();
  await once(upstream, "close");
  closeDb();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

const auth = { authorization: "Bearer studio-usage-token" };

describe("RAG usage synchronization", () => {
  it("imports all pages before summarizing and preserves workspace isolation", async () => {
    const response = await fetch(`${origin}/api/admin/usage?days=1`, { headers: auth });
    assert.equal(response.status, 200);
    const { usage } = (await response.json()) as { usage: UsageSummary };
    assert.equal(usage.totals.requests, 1);
    assert.equal(usage.totals.totalTokens, 25);
    assert.equal(authorized, true);
    assert.equal(requests, 2);
    const scoped = await fetch(`${origin}/api/admin/usage?days=1`, {
      headers: { ...auth, "x-workspace-id": workspaceId },
    });
    const body = (await scoped.json()) as { usage: UsageSummary };
    assert.equal(body.usage.totals.requests, 1);
    assert.equal(body.usage.totals.totalTokens, 50);
    assert.equal(body.usage.bySource[0]?.source, "rag_graph");
  });

  it("never duplicates usage when the outbox is replayed or polled concurrently", async () => {
    openDb().exec("DELETE FROM usage_sync_cursors");
    await Promise.all([syncRagUsage(), syncRagUsage(), syncRagUsage()]);
    assert.equal(listRecentUsage().length, 2);
    assert.equal(summarizeUsage().totals.requests, 2);
    assert.equal(summarizeUsage().totals.totalTokens, 75);
  });

  it("includes new background graph events in recent records and CSV/JSON exports", async () => {
    events.push({
      sequence: 3,
      id: "graph-2",
      kind: "chat",
      source: "rag_graph",
      model: "graph-model",
      requests: 1,
      inputTokens: 50,
      outputTokens: 15,
      workspaceId,
      createdAt: Date.now() - 10,
    });
    const response = await fetch(`${origin}/api/admin/usage/events?workspaceId=*`, {
      headers: auth,
    });
    const recent = (await response.json()) as { events: Array<{ id: string; source: string }> };
    assert.equal(recent.events.length, 3);
    assert.ok(
      recent.events.some((event) => event.id === "rag:graph-2" && event.source === "rag_graph"),
    );
    const exported = await fetch(`${origin}/api/admin/usage/export?format=json&workspaceId=*`, {
      headers: auth,
    });
    const rows = (await exported.json()) as Array<{
      source: string;
      requests: number;
      total_tokens: number;
    }>;
    assert.equal(rows.filter((row) => row.source === "rag_graph").length, 2);
    assert.equal(
      rows.reduce((total, row) => total + row.requests, 0),
      3,
    );
    assert.equal(
      rows.reduce((total, row) => total + row.total_tokens, 0),
      140,
    );
  });

  it("retains the last imported usage during an outage and retries invalid batches", async () => {
    unavailable = true;
    await syncRagUsage();
    assert.equal(summarizeUsage().totals.requests, 3);
    unavailable = false;
    events.push({
      sequence: 4,
      id: "answer-2",
      kind: "chat",
      source: "rag_query",
      requests: 1,
      model: "answer-model",
      inputTokens: 10,
      outputTokens: 3,
      createdAt: Date.now(),
    });
    invalid = true;
    await syncRagUsage();
    assert.equal(summarizeUsage().totals.requests, 3);
    invalid = false;
    await syncRagUsage();
    assert.equal(summarizeUsage().totals.requests, 4);
    assert.equal(summarizeUsage().totals.totalTokens, 153);
  });
});
