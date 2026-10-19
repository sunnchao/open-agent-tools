import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createApp } from "../app.js";
import { closeDb } from "../db.js";
import { recordUsageEvent } from "../usage.js";
import { createWorkspace } from "../workspace.js";

const TOKEN = "usage-export-token";
const USAGE_HEADER =
  "id,created_at,kind,workspace_id,model,tool_name,status,input_tokens,output_tokens,total_tokens,duration_ms,ref_id";

let server: Server;
let guarded: Server;
let origin: string;
let guardedOrigin: string;
let dir: string;

function portOf(listening: Server): number {
  const address = listening.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

/** `Response.text()` 会吞掉 BOM,导出校验必须按原始字节读取。 */
async function readUtf8(response: Response): Promise<string> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "usage-export-test-"));
  process.env.SQLITE_PATH = join(dir, "test.sqlite");
  delete process.env.STUDIO_API_TOKEN;
  delete process.env.SERVER_API_TOKEN;
  delete process.env.OIDC_ISSUER;
  delete process.env.OIDC_AUDIENCE;
  delete process.env.OIDC_JWKS_URI;
  delete process.env.EXPORT_MAX_ROWS;
  server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${portOf(server)}`;
  guarded = createApp({ studioAuth: { token: TOKEN } }).listen(0, "127.0.0.1");
  await once(guarded, "listening");
  guardedOrigin = `http://127.0.0.1:${portOf(guarded)}`;
});

after(async () => {
  server.close();
  await once(server, "close");
  guarded.close();
  await once(guarded, "close");
  closeDb();
  delete process.env.SQLITE_PATH;
  delete process.env.EXPORT_MAX_ROWS;
  rmSync(dir, { recursive: true, force: true });
});

describe("usage export API", () => {
  it("exports usage events as BOM-prefixed RFC4180 CSV with an attachment filename", async () => {
    recordUsageEvent({
      kind: "chat",
      sessionId: "会话-1",
      model: '海豚,"全角"',
      inputTokens: 10,
      outputTokens: 5,
      durationMs: 12,
    });
    recordUsageEvent({ kind: "chat", sessionId: "s2", model: "line1\nline2", durationMs: 4 });
    recordUsageEvent({
      kind: "tool",
      sessionId: "s3",
      toolKind: "mcp",
      toolName: "crm/get,contact",
      status: "error",
      durationMs: 3,
    });

    const response = await fetch(`${origin}/api/admin/usage/export?format=csv&days=1`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
    const disposition = response.headers.get("content-disposition") ?? "";
    assert.match(disposition, /^attachment; filename="usage-events-\d{8}-\d{6}\.csv"$/);
    assert.equal(response.headers.get("x-export-truncated"), null);

    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    assert.ok(text.startsWith("\ufeff"));
    const lines = text.slice(1).split("\r\n");
    assert.equal(lines[0], USAGE_HEADER);
    assert.equal(lines.at(-1), "");
    assert.ok(text.includes('"海豚,""全角"""'));
    assert.ok(text.includes('"line1\nline2"'));
    assert.ok(text.includes('"crm/get,contact"'));
  });

  it("returns the same fields as a JSON array", async () => {
    const response = await fetch(`${origin}/api/admin/usage/export?format=json&days=1&kind=tool`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
    assert.match(
      response.headers.get("content-disposition") ?? "",
      /^attachment; filename="usage-events-\d{8}-\d{6}\.json"$/,
    );
    const rows = (await response.json()) as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(rows));
    assert.ok(rows.length >= 1);
    assert.ok(rows.every((row) => row.kind === "tool"));
    assert.deepEqual(Object.keys(rows[0]!).sort(), [
      "created_at",
      "duration_ms",
      "id",
      "input_tokens",
      "kind",
      "model",
      "output_tokens",
      "ref_id",
      "status",
      "tool_name",
      "total_tokens",
      "workspace_id",
    ]);
    assert.equal(rows[0]!.tool_name, "crm/get,contact");
    assert.equal(rows[0]!.total_tokens, 0);
  });

  it("truncates at the configured cap and flags it with x-export-truncated", async () => {
    for (let index = 0; index < 5; index += 1) {
      recordUsageEvent({ kind: "chat", model: `cap-${index}`, durationMs: 1 });
    }
    process.env.EXPORT_MAX_ROWS = "3";
    try {
      const response = await fetch(`${origin}/api/admin/usage/export?format=csv&days=1`);
      assert.equal(response.headers.get("x-export-truncated"), "true");
      const lines = (await readUtf8(response)).slice(1).trim().split("\r\n");
      assert.equal(lines.length - 1, 3);
    } finally {
      delete process.env.EXPORT_MAX_ROWS;
    }
  });

  it("passes kind, workspace, and time-window filters through to the query", async () => {
    const workspace = createWorkspace({ name: "导出空间" });
    recordUsageEvent({ kind: "chat", workspaceId: workspace.id, model: "scoped", durationMs: 2 });
    const scoped = await fetch(`${origin}/api/admin/usage/export?format=json&days=1`, {
      headers: { "x-workspace-id": workspace.id },
    });
    const scopedRows = (await scoped.json()) as Array<{ workspace_id: string; model: string }>;
    assert.ok(scopedRows.length >= 1);
    assert.ok(scopedRows.every((row) => row.workspace_id === workspace.id));

    const global = await fetch(`${origin}/api/admin/usage/export?format=json&days=1`);
    const globalRows = (await global.json()) as Array<{ workspace_id: string }>;
    assert.ok(globalRows.some((row) => row.workspace_id === "default"));
    assert.equal(
      globalRows.some((row) => row.workspace_id === workspace.id),
      false,
    );

    const empty = await fetch(
      `${origin}/api/admin/usage/export?format=json&to=2000-01-01T00:00:00.000Z`,
    );
    assert.deepEqual(await empty.json(), []);
  });

  it("rejects unsupported format and kind", async () => {
    const badFormat = await fetch(`${origin}/api/admin/usage/export?format=xml`);
    assert.equal(badFormat.status, 400);
    const badKind = await fetch(`${origin}/api/admin/usage/export?kind=other`);
    assert.equal(badKind.status, 400);
  });

  it("requires authentication when a deployment token is configured", async () => {
    const unauthorized = await fetch(`${guardedOrigin}/api/admin/usage/export?format=csv`);
    assert.equal(unauthorized.status, 401);
    const authorized = await fetch(`${guardedOrigin}/api/admin/usage/export?format=csv`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(authorized.status, 200);
  });

  it("returns 503 when enterprise identity configuration is invalid", async () => {
    process.env.OIDC_ISSUER = "https://idp.example.test";
    const broken = createApp().listen(0, "127.0.0.1");
    await once(broken, "listening");
    try {
      const response = await fetch(
        `http://127.0.0.1:${portOf(broken)}/api/admin/usage/export?format=csv`,
      );
      assert.equal(response.status, 503);
    } finally {
      broken.close();
      await once(broken, "close");
      delete process.env.OIDC_ISSUER;
    }
  });
});
