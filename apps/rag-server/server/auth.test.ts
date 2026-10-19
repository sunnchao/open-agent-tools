import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import { test } from "node:test";
import express from "express";
import { assertRagAuthConfigured, resolveRagAuth } from "./auth.js";

async function startServer() {
  const auth = resolveRagAuth({ runtimeToken: "runtime-token", adminToken: "admin-token" });
  const app = express();
  app.use(auth.middleware);
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.post("/api/query", (_req, res) => res.json({ scope: res.locals.ragScope }));
  app.get("/api/documents", (_req, res) => res.json({ scope: res.locals.ragScope }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Server) {
  server.close();
  await once(server, "close");
}

test("health is public and OPTIONS bypasses auth for CORS preflight", async () => {
  const { server, origin } = await startServer();
  try {
    assert.equal((await fetch(`${origin}/api/health`)).status, 200);
    const preflight = await fetch(`${origin}/api/query`, { method: "OPTIONS" });
    assert.notEqual(preflight.status, 401);
  } finally {
    await closeServer(server);
  }
});

test("runtime token can query but cannot use admin endpoints", async () => {
  const { server, origin } = await startServer();
  const headers = { authorization: "Bearer runtime-token" };
  try {
    const query = await fetch(`${origin}/api/query`, { method: "POST", headers });
    assert.equal(query.status, 200);
    assert.deepEqual(await query.json(), { scope: "runtime" });
    assert.equal((await fetch(`${origin}/api/documents`, { headers })).status, 401);
  } finally {
    await closeServer(server);
  }
});

test("admin token can access runtime and admin endpoints", async () => {
  const { server, origin } = await startServer();
  const headers = { authorization: "Bearer admin-token" };
  try {
    assert.equal((await fetch(`${origin}/api/query`, { method: "POST", headers })).status, 200);
    const docs = await fetch(`${origin}/api/documents`, { headers });
    assert.equal(docs.status, 200);
    assert.deepEqual(await docs.json(), { scope: "admin" });
  } finally {
    await closeServer(server);
  }
});

test("missing and incorrect tokens are rejected", async () => {
  const { server, origin } = await startServer();
  try {
    assert.equal((await fetch(`${origin}/api/query`, { method: "POST" })).status, 401);
    assert.equal(
      (
        await fetch(`${origin}/api/query`, {
          method: "POST",
          headers: { authorization: "Bearer wrong" },
        })
      ).status,
      401,
    );
  } finally {
    await closeServer(server);
  }
});

test("production startup requires both service tokens", () => {
  assert.throws(() => assertRagAuthConfigured({ NODE_ENV: "production" }), /required/);
  assert.throws(
    () =>
      assertRagAuthConfigured({
        NODE_ENV: "production",
        RAG_RUNTIME_TOKEN: "runtime",
      }),
    /required/,
  );
  assert.doesNotThrow(() =>
    assertRagAuthConfigured({
      NODE_ENV: "production",
      RAG_RUNTIME_TOKEN: "runtime",
      RAG_ADMIN_TOKEN: "admin",
    }),
  );
});
