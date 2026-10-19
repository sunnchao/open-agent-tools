import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createApp } from "../app.js";
import { closeDb } from "../db.js";
import { AUDIT_EXPORT_COLUMNS } from "./auditExport.js";
import { createQueryAudit } from "../observatory/queryAudit.js";

const TOKEN = "audit-export-token";
const AUDIT_HEADER = AUDIT_EXPORT_COLUMNS.map((column) => column.header).join(",");

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

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "observatory-export-test-"));
  process.env.SQLITE_PATH = join(dir, "test.sqlite");
  process.env.CONFIG_SECRETS_ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
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
  delete process.env.CONFIG_SECRETS_ENCRYPTION_KEY;
  delete process.env.EXPORT_MAX_ROWS;
  rmSync(dir, { recursive: true, force: true });
});

describe("observatory audit export API", () => {
  it("exports audit summaries as BOM-prefixed CSV carrying SQL and escaped text fields", async () => {
    const audit = createQueryAudit("src-1", '查询用户,含"引号"', [], undefined, {
      actor: "operator:deploy",
      entrypoint: "observatory",
      source: "generated",
      workspace: "default",
      originalQuestion: "原始问题\n换行",
    });
    audit.patch({
      generatedSql: "SELECT id FROM users",
      executedSql: "SELECT id, name FROM users",
      rowCount: 3,
    });
    audit.finish("succeeded");

    const response = await fetch(`${origin}/api/observatory/audits/export?format=csv`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
    assert.match(
      response.headers.get("content-disposition") ?? "",
      /^attachment; filename="query-audits-\d{8}-\d{6}\.csv"$/,
    );
    assert.equal(response.headers.get("x-export-truncated"), null);

    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    assert.ok(text.startsWith("\ufeff"));
    assert.equal(text.slice(1).split("\r\n")[0], AUDIT_HEADER);
    assert.ok(text.includes("operator:deploy"));
    assert.ok(text.includes('"原始问题\n换行"'));
    assert.ok(text.includes("SELECT id FROM users"));
    assert.ok(text.includes('"SELECT id, name FROM users"'));
  });

  it("returns audit summaries as a JSON array with the same fields", async () => {
    const response = await fetch(`${origin}/api/observatory/audits/export?format=json`);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
    const rows = (await response.json()) as Array<Record<string, unknown>>;
    assert.ok(rows.length >= 1);
    assert.deepEqual(
      Object.keys(rows[0]!).sort(),
      [...AUDIT_EXPORT_COLUMNS.map((c) => c.header)].sort(),
    );
    const row = rows.find((item) => item.actor === "operator:deploy");
    assert.ok(row);
    assert.equal(row!.row_count, 3);
    assert.equal(row!.executed_sql, "SELECT id, name FROM users");
    assert.equal(row!.original_question, "原始问题\n换行");
    assert.equal(row!.workspace, "default");
  });

  it("passes audit filters through to the exported rows", async () => {
    const other = createQueryAudit("src-2", "另一个问题", [], undefined, {
      actor: "operator:other",
      entrypoint: "chat",
      source: "chat",
      workspace: "default",
    });
    other.patch({ generatedSql: "SELECT count(*) FROM orders", rowCount: 0 });
    other.finish("failed", "执行超时");

    const byEntrypoint = await fetch(
      `${origin}/api/observatory/audits/export?format=json&entrypoint=chat`,
    );
    const entrypointRows = (await byEntrypoint.json()) as Array<Record<string, unknown>>;
    assert.ok(entrypointRows.length >= 1);
    assert.ok(entrypointRows.every((row) => row.entrypoint === "chat"));

    const byActor = await fetch(
      `${origin}/api/observatory/audits/export?format=json&actor=${encodeURIComponent("operator:other")}`,
    );
    const actorRows = (await byActor.json()) as Array<Record<string, unknown>>;
    assert.equal(actorRows.length, 1);
    assert.equal(actorRows[0]!.status, "failed");

    const bySearch = await fetch(
      `${origin}/api/observatory/audits/export?format=json&search=${encodeURIComponent("另一个")}`,
    );
    const searchRows = (await bySearch.json()) as Array<Record<string, unknown>>;
    assert.equal(searchRows.length, 1);
    assert.equal(searchRows[0]!.question ?? searchRows[0]!.original_question, "另一个问题");
  });

  it("truncates at the configured cap and flags it with x-export-truncated", async () => {
    createQueryAudit("src-3", "第三条", [], undefined, { workspace: "default" }).finish(
      "succeeded",
    );
    process.env.EXPORT_MAX_ROWS = "1";
    try {
      const response = await fetch(`${origin}/api/observatory/audits/export?format=json`);
      assert.equal(response.headers.get("x-export-truncated"), "true");
      assert.equal(((await response.json()) as unknown[]).length, 1);
    } finally {
      delete process.env.EXPORT_MAX_ROWS;
    }
  });

  it("rejects an unsupported format", async () => {
    const response = await fetch(`${origin}/api/observatory/audits/export?format=yaml`);
    assert.equal(response.status, 400);
  });

  it("stays protected by studio auth (run scope) when a deployment token is configured", async () => {
    const unauthorized = await fetch(`${guardedOrigin}/api/observatory/audits/export?format=csv`);
    assert.equal(unauthorized.status, 401);
    const authorized = await fetch(`${guardedOrigin}/api/observatory/audits/export?format=csv`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(authorized.status, 200);
  });
});
