import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../../app.js";
import { closeDb } from "../../platform/db.js";

let dir: string;
let server: Server;
let sourceServer: Server;
let ragServer: Server;
let origin: string;
let sourceUrl = "";
const ragUploads: string[] = [];
const ragHeadersSeen: Array<IncomingMessage["headers"]> = [];

const authHeaders = { authorization: "Bearer deploy-token" };

test.before(async () => {
  dir = mkdtempSync(join(tmpdir(), "connector-app-test-"));
  process.env.NODE_ENV = "test";
  process.env.SQLITE_PATH = join(dir, "test.sqlite");
  process.env.CONFIG_SECRETS_ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.STUDIO_API_TOKEN = "deploy-token";
  process.env.RAG_ADMIN_TOKEN = "rag-admin-secret";

  sourceServer = http.createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        documents: [
          { id: "hr/leave", title: "休假政策", content: "# 年假" },
          { id: "hr/travel", title: "差旅", content: "# 报销" },
        ],
      }),
    );
  });
  sourceServer.listen(0, "127.0.0.1");
  await once(sourceServer, "listening");

  ragServer = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    ragHeadersSeen.push(req.headers);
    const body = await readBody(req);
    ragUploads.push(body.toString("utf8"));
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ files: 1, chunks: 1 }));
  });
  ragServer.listen(0, "127.0.0.1");
  await once(ragServer, "listening");

  const sourceAddress = sourceServer.address();
  assert.ok(sourceAddress && typeof sourceAddress === "object");
  const ragAddress = ragServer.address();
  assert.ok(ragAddress && typeof ragAddress === "object");
  process.env.RAG_API_URL = `http://127.0.0.1:${ragAddress.port}/api`;

  server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
  sourceUrl = `http://127.0.0.1:${sourceAddress.port}`;
});

test.after(async () => {
  server.close();
  await once(server, "close");
  sourceServer.close();
  await once(sourceServer, "close");
  ragServer.close();
  await once(ragServer, "close");
  closeDb();
  delete process.env.SQLITE_PATH;
  delete process.env.CONFIG_SECRETS_ENCRYPTION_KEY;
  delete process.env.STUDIO_API_TOKEN;
  delete process.env.RAG_ADMIN_TOKEN;
  delete process.env.RAG_API_URL;
  rmSync(dir, { recursive: true, force: true });
});

test("connectors admin API requires the Studio token", async () => {
  const denied = await fetch(`${origin}/api/admin/connectors`);
  assert.equal(denied.status, 401);
});

test("connectors admin API rejects an unknown type", async () => {
  const response = await fetch(`${origin}/api/admin/connectors`, {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify({ name: "bad", type: "carrier-pigeon" }),
  });
  assert.equal(response.status, 400);
});

test("connector lifecycle: create, sync (idempotent), list runs, update, delete", async () => {
  const created = await fetch(`${origin}/api/admin/connectors`, {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      name: "HR 文档",
      type: "http",
      baseUrl: sourceUrl,
      credentials: { token: "upstream-secret" },
      filter: { include: ["hr/*"] },
    }),
  });
  assert.equal(created.status, 201);
  const createdBody = (await created.json()) as {
    connector: { id: string; hasCredential: boolean; credentialKeys: string[] };
  };
  const id = createdBody.connector.id;
  assert.equal(createdBody.connector.hasCredential, true);
  assert.deepEqual(createdBody.connector.credentialKeys, ["token"]);
  assert.equal(JSON.stringify(createdBody).includes("upstream-secret"), false);

  const firstSync = await fetch(`${origin}/api/admin/connectors/${id}/sync`, {
    method: "POST",
    headers: authHeaders,
  });
  assert.equal(firstSync.status, 200);
  const firstRun = (await firstSync.json()) as {
    run: { status: string; pulled: number; ingested: number; skipped: number; failed: number };
    connector: Record<string, unknown> | null;
  };
  assert.equal(firstRun.run.status, "success");
  assert.equal(firstRun.run.pulled, 2);
  assert.equal(firstRun.run.ingested, 2);
  assert.equal(firstRun.run.skipped, 0);
  assert.equal(ragUploads.length, 2);
  assert.match(ragUploads[0] ?? "", /name="files"; filename="/);
  assert.match(ragUploads[0] ?? "", /name="chunkStrategy"/);
  assert.equal(ragHeadersSeen[0]?.authorization, "Bearer rag-admin-secret");
  // 同步响应不能把解密后的上游凭据带回浏览器。
  assert.equal(JSON.stringify(firstRun.connector).includes("upstream-secret"), false);
  assert.equal("credentials" in (firstRun.connector ?? {}), false);

  const secondSync = await fetch(`${origin}/api/admin/connectors/${id}/sync`, {
    method: "POST",
    headers: authHeaders,
  });
  const secondRun = (await secondSync.json()) as {
    run: { ingested: number; skipped: number };
  };
  assert.equal(secondRun.run.ingested, 0);
  assert.equal(secondRun.run.skipped, 2);
  assert.equal(ragUploads.length, 2);

  const runs = await fetch(`${origin}/api/admin/connectors/${id}/runs`, { headers: authHeaders });
  const runsBody = (await runs.json()) as { runs: Array<{ skipped: number }> };
  assert.equal(runsBody.runs.length, 2);
  assert.equal(runsBody.runs[0]?.skipped, 2);

  const updated = await fetch(`${origin}/api/admin/connectors/${id}`, {
    method: "PUT",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify({ enabled: false, name: "HR 文档 (停用)" }),
  });
  assert.equal(updated.status, 200);
  const updatedBody = (await updated.json()) as { connector: { enabled: boolean; name: string } };
  assert.equal(updatedBody.connector.enabled, false);
  assert.equal(updatedBody.connector.name, "HR 文档 (停用)");

  const listed = await fetch(`${origin}/api/admin/connectors`, { headers: authHeaders });
  const listedBody = (await listed.json()) as { connectors: Array<{ id: string }> };
  assert.equal(listedBody.connectors.length, 1);

  const removed = await fetch(`${origin}/api/admin/connectors/${id}`, {
    method: "DELETE",
    headers: authHeaders,
  });
  assert.equal(removed.status, 204);

  const synced = await fetch(`${origin}/api/admin/connectors/${id}/sync`, {
    method: "POST",
    headers: authHeaders,
  });
  assert.equal(synced.status, 404);
});

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
