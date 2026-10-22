import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createApp } from "../app.js";
import { closeDb, createSession } from "../db.js";
import { recordImChatAudit } from "../im/audit.js";
import { createWorkspace } from "../workspace.js";

let server: Server;
let origin: string;
let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "audit-api-test-"));
  process.env.SQLITE_PATH = join(dir, "test.sqlite");
  delete process.env.STUDIO_API_TOKEN;
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
  delete process.env.SQLITE_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe("audit API", () => {
  it("lists IM audits with filters and pagination", async () => {
    recordImChatAudit({
      platform: "feishu",
      workspace: "default",
      actor: "u1",
      chatType: "p2p",
      status: "ok",
      question: "报销怎么走",
    });
    recordImChatAudit({
      platform: "dingtalk",
      workspace: "default",
      actor: "u2",
      chatType: "group",
      status: "error",
      question: "营收",
      error: "boom",
    });

    const all = await fetch(`${origin}/api/admin/audit/im/audits`);
    assert.equal(all.status, 200);
    const allBody = (await all.json()) as { items: unknown[]; total: number };
    assert.equal(allBody.total, 2);
    assert.equal(allBody.items.length, 2);

    const byPlatform = await fetch(`${origin}/api/admin/audit/im/audits?platform=dingtalk`);
    const platformBody = (await byPlatform.json()) as { items: unknown[]; total: number };
    assert.equal(platformBody.total, 1);

    const byActor = await fetch(`${origin}/api/admin/audit/im/audits?actor=u1`);
    assert.equal(((await byActor.json()) as { total: number }).total, 1);

    const byStatus = await fetch(`${origin}/api/admin/audit/im/audits?status=error`);
    assert.equal(((await byStatus.json()) as { total: number }).total, 1);

    const byKeyword = await fetch(`${origin}/api/admin/audit/im/audits?keyword=报销`);
    assert.equal(((await byKeyword.json()) as { total: number }).total, 1);

    const paged = await fetch(`${origin}/api/admin/audit/im/audits?limit=1&offset=0`);
    const pagedBody = (await paged.json()) as { items: unknown[]; total: number };
    assert.equal(pagedBody.items.length, 1);
    assert.equal(pagedBody.total, 2);
  });

  it("returns a single IM audit by id", async () => {
    const created = recordImChatAudit({ platform: "feishu", question: "单条" });
    assert.ok(created);
    const response = await fetch(`${origin}/api/admin/audit/im/audits/${created.id}`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { audit: { question: string } };
    assert.equal(body.audit.question, "单条");

    const missing = await fetch(`${origin}/api/admin/audit/im/audits/nope`);
    assert.equal(missing.status, 404);
  });

  it("scopes IM audit details to the requested workspace", async () => {
    const workspace = createWorkspace({ name: "审计详情空间" });
    const audit = recordImChatAudit({
      platform: "feishu",
      workspace: workspace.id,
      question: "空间内详情",
    });
    assert.ok(audit);
    const url = `${origin}/api/admin/audit/im/audits/${audit.id}`;

    const matching = await fetch(url, { headers: { "x-workspace-id": workspace.id } });
    assert.equal(matching.status, 200);
    assert.equal(((await matching.json()) as { audit: { id: string } }).audit.id, audit.id);
    assert.equal((await fetch(url)).status, 404);
    assert.equal(
      (await fetch(url, { headers: { "x-workspace-id": "missing-workspace" } })).status,
      400,
    );
  });

  it("aggregates the audit overview sections and explains the MCP boundary", async () => {
    const response = await fetch(`${origin}/api/admin/audit/overview`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      sections: Array<{ key: string; title: string; total: number; items: unknown[] }>;
      note: string;
    };
    const keys = body.sections.map((section) => section.key);
    assert.ok(keys.includes("im"));
    assert.ok(keys.includes("query"));
    assert.ok(keys.includes("usage"));
    assert.match(body.note, /mcp-api/);
  });
});

describe("sessions source filter", () => {
  it("returns only web sessions by default and supports explicit source queries", async () => {
    const workspace = createWorkspace({ name: "来源测试" });
    createSession({ id: "web-s", workspaceId: workspace.id, title: "web" });
    createSession({
      id: "im-s",
      workspaceId: workspace.id,
      title: "im",
      source: "im",
      actor: "u1",
      channelId: "chan_1",
    });

    const headers = { "x-workspace-id": workspace.id };
    const webResponse = await fetch(`${origin}/api/sessions`, { headers });
    const webBody = (await webResponse.json()) as { sessions: Array<{ id: string }> };
    assert.deepEqual(
      webBody.sessions.map((session) => session.id),
      ["web-s"],
    );

    const imResponse = await fetch(`${origin}/api/sessions?source=im`, { headers });
    const imBody = (await imResponse.json()) as { sessions: Array<{ id: string }> };
    assert.deepEqual(
      imBody.sessions.map((session) => session.id),
      ["im-s"],
    );

    const allResponse = await fetch(`${origin}/api/sessions?source=all`, { headers });
    const allBody = (await allResponse.json()) as { sessions: Array<{ id: string }> };
    assert.equal(allBody.sessions.length, 2);
  });
});
