import assert from "node:assert/strict";
import { once } from "node:events";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Server } from "node:http";
import { test } from "node:test";
import { createApp } from "../app.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../db.js";
import { createWorkspace } from "../workspace.js";

let server: Server;
let upstream: Server;
let origin: string;
let upstreamOrigin: string;
let dir: string;
const calls: Array<{
  url: string;
  method?: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}> = [];

test.before(async () => {
  dir = mkdtempSync(join(tmpdir(), "rag-admin-test-"));
  process.env.SQLITE_PATH = join(dir, "test.sqlite");
  process.env.NODE_ENV = "test";
  process.env.STUDIO_API_TOKEN = "deploy-token";
  process.env.RAG_ADMIN_TOKEN = "rag-admin-secret";
  upstream = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    calls.push({
      url: req.url ?? "",
      method: req.method,
      headers: req.headers,
      body: await readBody(req),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === "object");
  upstreamOrigin = `http://127.0.0.1:${upstreamAddress.port}/api`;
  process.env.RAG_API_URL = upstreamOrigin;

  server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  server.close();
  await once(server, "close");
  upstream.close();
  await once(upstream, "close");
  delete process.env.STUDIO_API_TOKEN;
  delete process.env.RAG_API_URL;
  delete process.env.RAG_ADMIN_TOKEN;
  closeDb();
  delete process.env.SQLITE_PATH;
  rmSync(dir, { recursive: true, force: true });
});

test("RAG admin BFF requires the Studio token", async () => {
  calls.length = 0;
  const denied = await fetch(`${origin}/api/admin/rag/documents`);
  assert.equal(denied.status, 401);
  assert.equal(calls.length, 0);
});

test("RAG admin BFF forwards path/query/body and injects the admin token", async () => {
  calls.length = 0;
  const response = await fetch(`${origin}/api/admin/rag/documents/hr.md?x=1`, {
    method: "PATCH",
    headers: {
      authorization: "Bearer deploy-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ allowedGroups: ["hr"] }),
  });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "/api/documents/hr.md?x=1");
  assert.equal(calls[0]?.headers.authorization, "Bearer rag-admin-secret");
  assert.equal(calls[0]?.headers["x-workspace-id"], "default");
  assert.equal(calls[0]?.body.toString(), JSON.stringify({ allowedGroups: ["hr"] }));
});

test("RAG admin BFF streams multipart uploads without dropping the body", async () => {
  calls.length = 0;
  const form = new FormData();
  form.append("files", new File(["hello"], "notes.txt", { type: "text/plain" }));
  form.append("chunkStrategy", "fixed");
  const response = await fetch(`${origin}/api/admin/rag/documents`, {
    method: "POST",
    headers: { authorization: "Bearer deploy-token" },
    body: form,
  });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "/api/documents");
  assert.equal(calls[0]?.headers.authorization, "Bearer rag-admin-secret");
  assert.match(calls[0]?.headers["content-type"] ?? "", /^multipart\/form-data; boundary=/);
  const body = calls[0]?.body ?? Buffer.alloc(0);
  assert.match(body.toString("utf8"), /name="files"; filename="notes.txt"/);
  assert.match(body.toString("utf8"), /hello/);
});

test("RAG admin BFF attributes requests to the selected workspace", async () => {
  calls.length = 0;
  const workspace = createWorkspace({ name: "RAG usage" });
  const response = await fetch(`${origin}/api/admin/rag/graph/reconcile`, {
    method: "POST",
    headers: { authorization: "Bearer deploy-token", "x-workspace-id": workspace.id },
  });
  assert.equal(response.status, 200);
  assert.equal(calls[0]?.headers["x-workspace-id"], workspace.id);
});

test("RAG admin BFF rejects unknown workspaces before calling the upstream", async () => {
  calls.length = 0;
  const response = await fetch(`${origin}/api/admin/rag/documents`, {
    headers: { authorization: "Bearer deploy-token", "x-workspace-id": "unknown-workspace" },
  });
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
