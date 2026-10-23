import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { closeDb } from "../db.js";
import { listAuditExportRows } from "../export/auditExport.js";
import type { QueryAuditFilters } from "./queryAudit.js";
import {
  createQueryAudit,
  getQueryAudit,
  listQueryAudits,
  resolveOperatorActor,
} from "./queryAudit.js";

let dir: string;
const previousPath = process.env.SQLITE_PATH;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "query-audit-migration-"));
  process.env.SQLITE_PATH = join(dir, "legacy.sqlite");
  const legacy = new DatabaseSync(process.env.SQLITE_PATH);
  legacy.exec(`
    CREATE TABLE observatory_query_audits (
      id TEXT PRIMARY KEY,
      source_id TEXT,
      status TEXT NOT NULL,
      question TEXT NOT NULL,
      started_at TEXT NOT NULL,
      record_json TEXT NOT NULL
    );
    INSERT INTO observatory_query_audits
      (id, source_id, status, question, started_at, record_json)
    VALUES
      ('legacy-1', 'source-1', 'succeeded', '旧问题', '2026-01-01T00:00:00.000Z',
       '{"id":"legacy-1","sourceId":"source-1","question":"旧问题","status":"succeeded","startedAt":"2026-01-01T00:00:00.000Z","finishedAt":null,"durationMs":12,"rowCount":0,"error":null,"history":[],"steps":[],"selectedTables":[],"sql":null,"clarifying":null,"providerId":null,"model":null,"resultPreview":[]}');
  `);
  legacy.close();
});

after(() => {
  closeDb();
  if (previousPath === undefined) delete process.env.SQLITE_PATH;
  else process.env.SQLITE_PATH = previousPath;
  rmSync(dir, { recursive: true, force: true });
});

test("old audit tables are ALTERed without losing legacy rows", () => {
  const rows = listQueryAudits({ workspace: "default" });
  assert.equal(rows.total, 1);
  const record = getQueryAudit("legacy-1")!;
  assert.equal(record.actor, "operator:deployment");
  assert.equal(record.actorType, "legacy");
  assert.equal(record.entrypoint, "unknown");
  assert.equal(record.workspace, "default");

  const db = new DatabaseSync(process.env.SQLITE_PATH!);
  const columns = new Set(
    (
      db.prepare("PRAGMA table_info(observatory_query_audits)").all() as Array<{ name: string }>
    ).map((row) => row.name),
  );
  db.close();
  for (const column of [
    "actor",
    "entrypoint",
    "source",
    "sql_source",
    "parent_audit_id",
    "workspace",
    "original_question",
    "generated_sql",
    "executed_sql",
    "clarification_json",
  ]) {
    assert.ok(columns.has(column), `missing migrated column ${column}`);
  }
});

test("new audits expose queryable metadata and operator fingerprints", () => {
  const audit = createQueryAudit(undefined, "新问题", [], undefined, {
    actor: resolveOperatorActor({
      header: (name) => (name === "authorization" ? "Bearer deploy-secret" : undefined),
    }),
    entrypoint: "observatory",
    source: "generated",
    workspace: "default",
    originalQuestion: "最初问题",
  });
  audit.finish("failed", "test");
  const record = getQueryAudit(audit.record.id)!;
  assert.match(record.actor, /^operator-token:[a-f0-9]{16}$/);
  assert.equal(record.actor.includes("deploy-secret"), false);
  assert.equal(record.actorType, "operator");
  assert.equal(record.entrypoint, "observatory");
  assert.equal(record.source, "generated");
  assert.equal(record.originalQuestion, "最初问题");
  assert.equal(listQueryAudits({ actor: record.actor }).total, 1);
  assert.equal(listQueryAudits({ entrypoint: "observatory" }).total, 1);
  assert.equal(listQueryAudits({ source: "generated", workspace: "default" }).total, 2);
  assert.equal(listQueryAudits({ search: "新问题", workspace: "default" }).total, 1);
  assert.equal(
    listQueryAudits({
      from: new Date(Date.now() + 86_400_000).toISOString(),
      workspace: "default",
    }).total,
    0,
  );
});

test("resolveOperatorActor ignores spoofed explicit operators when disabled", () => {
  const actor = resolveOperatorActor(
    {
      header: (name) =>
        name === "x-operator-id"
          ? "ceo@example.com"
          : name === "authorization"
            ? "Bearer token-a"
            : undefined,
    },
    { allowExplicitOperator: false },
  );
  assert.match(actor, /^operator-token:/);
  assert.equal(actor.includes("ceo"), false);
  assert.equal(
    resolveOperatorActor(
      {
        header: (name) => (name === "x-operator-id" ? "ceo@example.com" : undefined),
      },
      { allowExplicitOperator: false },
    ),
    "operator:deployment",
  );
});

test("审计列表和导出共用筛选，保持 workspace、SQL 来源和搜索结果一致", () => {
  for (const workspace of ["workspace-a", "workspace-b"]) {
    const audit = createQueryAudit("source-parity", "筛选一致性", [], undefined, {
      actor: "operator:reviewer",
      entrypoint: "observatory",
      source: "rerun",
      workspace,
      parentAuditId: "parent-parity",
      sqlSource: "edited",
    });
    audit.patch({ generatedSql: "SELECT parity_column", executedSql: "SELECT parity_column" });
    audit.finish("succeeded");
  }
  const filters: QueryAuditFilters[] = [
    { workspace: "workspace-a" },
    { sourceId: "source-parity" },
    { actor: "operator:reviewer" },
    { entrypoint: "observatory", status: "succeeded" },
    { source: "rerun", sqlSource: "edited" },
    { parentAuditId: "parent-parity" },
    { search: "parity_column" },
    { search: "一致性", workspace: "workspace-b" },
    { from: "2000-01-01", to: "2999-12-31" },
    { workspace: "no-access" },
  ];
  for (const filter of filters) {
    const list = listQueryAudits({ ...filter, limit: 100 });
    const exported = listAuditExportRows(filter, 100);
    assert.equal(exported.truncated, false);
    assert.equal(list.total, exported.rows.length);
    assert.deepEqual(
      list.records.map((record) => record.id),
      exported.rows.map((row) => row.id),
    );
  }
});
