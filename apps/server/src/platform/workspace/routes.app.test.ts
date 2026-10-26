import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createApp } from "../../app.js";
import { closeDb, DEFAULT_WORKSPACE_ID } from "../db.js";
import { recordUsageEvent, summarizeUsage } from "../usage/events.js";
import { WORKSPACE_HEADER } from "./store.js";

let server: Server;
let origin: string;
let dir: string;
let workspaceId = "";

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "workspace-api-test-"));
  process.env.SQLITE_PATH = join(dir, "test.sqlite");
  process.env.CONFIG_SECRETS_ENCRYPTION_KEY =
    "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
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
  delete process.env.CONFIG_SECRETS_ENCRYPTION_KEY;
  rmSync(dir, { recursive: true, force: true });
});

describe("workspace isolation", () => {
  it("bootstraps the default workspace", async () => {
    const response = await fetch(`${origin}/api/admin/workspaces`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { workspaces: Array<{ id: string; name: string }> };
    assert.equal(body.workspaces[0]?.id, DEFAULT_WORKSPACE_ID);
  });

  it("creates a workspace and scopes sessions to it", async () => {
    const created = await fetch(`${origin}/api/admin/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "交付部", description: "客户交付" }),
    });
    assert.equal(created.status, 201);
    workspaceId = ((await created.json()) as { workspace: { id: string } }).workspace.id;

    // 默认空间建一个会话
    const defaultSession = await fetch(`${origin}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "s-default", title: "默认空间会话" }),
    });
    assert.equal(defaultSession.status, 201);

    // 新空间建一个会话
    const scopedSession = await fetch(`${origin}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", [WORKSPACE_HEADER]: workspaceId },
      body: JSON.stringify({ id: "s-scoped", title: "交付部会话" }),
    });
    assert.equal(scopedSession.status, 201);

    const scopedList = await fetch(`${origin}/api/sessions`, {
      headers: { [WORKSPACE_HEADER]: workspaceId },
    });
    const scopedIds = (
      (await scopedList.json()) as { sessions: Array<{ id: string }> }
    ).sessions.map((session) => session.id);
    assert.deepEqual(scopedIds, ["s-scoped"]);
  });

  it("rejects an unknown workspace instead of silently falling back", async () => {
    const response = await fetch(`${origin}/api/sessions`, {
      headers: { [WORKSPACE_HEADER]: "does-not-exist" },
    });
    assert.equal(response.status, 400);
    assert.match(
      ((await response.json()) as { error: string }).error,
      /workspace not found: does-not-exist/,
    );
  });

  it("scopes usage summaries and exposes a global view", async () => {
    recordUsageEvent({ kind: "chat", workspaceId, model: "gpt-4o-mini", inputTokens: 10 });
    recordUsageEvent({ kind: "chat", workspaceId: DEFAULT_WORKSPACE_ID, inputTokens: 90 });

    const scoped = await fetch(`${origin}/api/admin/usage?days=1`, {
      headers: { [WORKSPACE_HEADER]: workspaceId },
    });
    const scopedBody = (await scoped.json()) as {
      usage: { workspaceId: string; totals: { inputTokens: number } };
    };
    assert.equal(scopedBody.usage.workspaceId, workspaceId);
    assert.equal(scopedBody.usage.totals.inputTokens, 10);

    const global = await fetch(`${origin}/api/admin/usage?days=1&workspaceId=*`);
    const globalBody = (await global.json()) as {
      usage: { workspaceId: string; totals: { inputTokens: number } };
    };
    assert.equal(globalBody.usage.workspaceId, "*");
    assert.equal(globalBody.usage.totals.inputTokens, 100);

    // 底层汇总函数与接口口径一致
    assert.equal(
      summarizeUsage(Date.now() - 60_000, Date.now() + 60_000, workspaceId).totals.inputTokens,
      10,
    );
  });
});
