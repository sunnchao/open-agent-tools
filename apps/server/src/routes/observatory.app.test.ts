import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { createApp } from "../app.js";
import { closeDb } from "../db.js";
import { getQueryAudit, listQueryAudits } from "../observatory/queryAudit.js";
import type { ObservatoryQueryResult } from "../oneapiDemo/text2sql.js";
import { OpenAIChatClient } from "../providers/clients/openai-chat.js";
import { createProvider, setDefaultProvider } from "../providers/store.js";
import { invalidateSchemaSource } from "../schemaSources/runtime.js";
import { createSchemaSource } from "../schemaSources/store.js";

const requireDatabase = createRequire(
  new URL("../../../../packages/database/package.json", import.meta.url),
);
const { PromisePool } = requireDatabase("mysql2/promise") as {
  PromisePool: { prototype: { query: (...args: unknown[]) => Promise<unknown> } };
};

let server: Server;
let origin: string;
let dir: string;
let sourceId: string;
let generated: { sql?: string; clarifying?: string };
let generationError: string | null;
let generationGate: Promise<void> | null;
let executionError: string | null;
let executionCount = 0;
let resultRows: Record<string, unknown>[];
const previousEnv = {
  SQLITE_PATH: process.env.SQLITE_PATH,
  CONFIG_SECRETS_ENCRYPTION_KEY: process.env.CONFIG_SECRETS_ENCRYPTION_KEY,
  SCHEMA_SOURCE_URL: process.env.SCHEMA_SOURCE_URL,
  REPORT_DATABASE_URL: process.env.REPORT_DATABASE_URL,
  AI_QUERY_PROVIDER_ID: process.env.AI_QUERY_PROVIDER_ID,
  AI_QUERY_MODEL: process.env.AI_QUERY_MODEL,
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "observatory-api-test-"));
  process.env.SQLITE_PATH = join(dir, "test.sqlite");
  process.env.CONFIG_SECRETS_ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  delete process.env.SCHEMA_SOURCE_URL;
  delete process.env.REPORT_DATABASE_URL;
  delete process.env.AI_QUERY_MODEL;
  const source = createSchemaSource({
    name: "审计测试库",
    connectionString: "mysql://readonly:database-secret@localhost/demo",
    semanticProfile: "generic",
  });
  sourceId = source.id;
  const provider = createProvider({
    name: "测试模型",
    baseUrl: "http://localhost:1/v1",
    apiKey: "provider-secret",
    models: ["test-model"],
  });
  setDefaultProvider(provider.id);
  process.env.AI_QUERY_PROVIDER_ID = provider.id;

  // Exercise the real catalog, graph, SQL guard, and audit store without external services.
  mock.method(PromisePool.prototype, "query", async (query: unknown) => {
    const sql = typeof query === "string" ? query : (query as { sql: string }).sql;
    if (sql.includes("information_schema.TABLES")) {
      return [[{ TABLE_NAME: "users", TABLE_COMMENT: "用户", TABLE_ROWS: 2 }], []];
    }
    if (sql.includes("information_schema.COLUMNS")) {
      return [
        [
          {
            TABLE_NAME: "users",
            COLUMN_NAME: "id",
            COLUMN_TYPE: "int",
            IS_NULLABLE: "NO",
            COLUMN_KEY: "PRI",
            COLUMN_DEFAULT: null,
            COLUMN_COMMENT: "编号",
            ORDINAL_POSITION: 1,
          },
        ],
        [],
      ];
    }
    if (sql.includes("information_schema.")) return [[], []];
    executionCount += 1;
    if (executionError) throw new Error(executionError);
    return [resultRows, []];
  });
  mock.method(OpenAIChatClient.prototype, "complete", async () => {
    await generationGate;
    if (generationError) throw new Error(generationError);
    return { content: JSON.stringify(generated) };
  });
  server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  generated = { sql: "SELECT id FROM users" };
  generationError = null;
  generationGate = null;
  executionError = null;
  executionCount = 0;
  resultRows = [{ id: 1, api_key: "private-result-key" }];
});

after(async () => {
  server.close();
  await once(server, "close");
  invalidateSchemaSource(sourceId);
  closeDb();
  mock.restoreAll();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

async function query(body: Record<string, unknown>, streaming = false) {
  return fetch(`${origin}/api/observatory/query`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(streaming ? { accept: "text/event-stream" } : {}),
    },
    body: JSON.stringify({ sourceId, question: "查询前 100 条 users", ...body }),
  });
}

async function rerun(body: Record<string, unknown>, workspaceHeader?: string) {
  return fetch(`${origin}/api/observatory/query/rerun`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(workspaceHeader ? { "x-workspace-id": workspaceHeader } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("observatory execution and audit API", () => {
  it("exposes persisted in-flight progress while the model is still generating SQL", async () => {
    let release!: () => void;
    generationGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const response = await query({}, true);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let wire = "";
    try {
      while (!wire.includes('"id":"generation","label":"生成 SQL","status":"running"')) {
        const { value, done } = await reader.read();
        assert.equal(done, false);
        wire += decoder.decode(value, { stream: true });
      }
      const start = JSON.parse(wire.split("\n\n")[0]!.slice(6)) as { auditId: string };
      const record = getQueryAudit(start.auditId)!;
      assert.equal(record.status, "running");
      assert.equal(record.steps.find((step) => step.id === "generation")?.status, "running");
      assert.equal(record.steps.find((step) => step.id === "execution")?.status, "pending");
      assert.equal(listQueryAudits({ sourceId, status: "running" }).total, 1);
      release();
      while (!(await reader.read()).done) {
        /* Drain the completed response. */
      }
      assert.equal(getQueryAudit(start.auditId)?.status, "succeeded");
    } finally {
      release();
      await reader.cancel();
      reader.releaseLock();
    }
  });

  it("streams every actual step and persists a successful result with redacted audit preview", async () => {
    const response = await query({}, true);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const events = (await response.text())
      .split("\n\n")
      .filter((value) => value.startsWith("data:"))
      .map((value) => JSON.parse(value.slice(6)) as Record<string, unknown>);
    assert.equal(events[0]?.type, "start");
    const final = events.at(-1);
    assert.equal(final?.type, "result");
    const result = final!.result as ObservatoryQueryResult;
    assert.equal(result.rows?.length, 1);
    assert.equal(result.rows?.[0]?.api_key, "private-result-key");
    assert.deepEqual(
      result.steps.map((step) => step.status),
      Array(7).fill("succeeded"),
    );
    assert.deepEqual(
      events
        .filter((event) => event.type === "step")
        .map((event) => {
          const step = event.step as { id: string; status: string };
          return `${step.id}:${step.status}`;
        }),
      result.steps.flatMap((step) => [`${step.id}:running`, `${step.id}:succeeded`]),
    );
    const record = getQueryAudit(result.auditId)!;
    assert.equal(record.status, "succeeded");
    assert.equal(record.rowCount, 1);
    assert.equal(record.sourceName, "审计测试库");
    assert.equal(record.model, "test-model");
    assert.equal(record.sql, "SELECT id FROM users");
    assert.equal(record.resultPreview[0]?.api_key, "[REDACTED]");
    assert.ok(record.finishedAt);
    assert.ok(
      record.steps.every(
        (step) => step.startedAt && step.finishedAt && typeof step.durationMs === "number",
      ),
    );
    assert.equal(JSON.stringify(record).includes("database-secret"), false);
    assert.equal(JSON.stringify(record).includes("provider-secret"), false);
    assert.equal(executionCount, 1);
  });

  it("marks SQL validation failure and skips execution and output", async () => {
    generated = { sql: "DELETE FROM users" };
    const result = (await (
      await query({ question: "危险 SQL 前 100 条" })
    ).json()) as ObservatoryQueryResult;
    assert.match(result.error ?? "", /禁止/);
    assert.equal(result.steps.find((step) => step.id === "validation")?.status, "failed");
    assert.equal(result.steps.find((step) => step.id === "execution")?.status, "skipped");
    assert.equal(result.steps.find((step) => step.id === "output")?.status, "skipped");
    assert.equal(executionCount, 0);
    assert.equal(getQueryAudit(result.auditId)?.status, "failed");
  });

  it("records clarifications and their history without executing SQL", async () => {
    generated = { clarifying: "请补充时间范围" };
    const result = (await (
      await query({
        question: "查看用户 50 条",
        history: [
          { role: "user", content: "查看用户" },
          { role: "assistant", content: "请确认需要查询多少条？" },
        ],
      })
    ).json()) as ObservatoryQueryResult;
    const record = getQueryAudit(result.auditId)!;
    assert.equal(record.status, "clarifying");
    assert.equal(record.clarifying, "请补充时间范围");
    assert.equal(record.history.length, 2);
    assert.equal(record.steps.find((step) => step.id === "generation")?.status, "succeeded");
    assert.ok(record.steps.slice(4).every((step) => step.status === "skipped"));
    assert.equal(executionCount, 0);
  });

  it("does not ask the same clarification slot twice", async () => {
    generated = { clarifying: "请补充时间范围" };
    const result = (await (
      await query({
        question: "查看用户 20 条",
        originalQuestion: "查看用户",
        history: [
          { role: "user", content: "查看用户" },
          { role: "assistant", content: "请补充时间范围" },
        ],
      })
    ).json()) as ObservatoryQueryResult;
    assert.match(result.error ?? "", /已追问/);
    assert.equal(result.clarification, undefined);
    assert.equal(getQueryAudit(result.auditId)?.status, "failed");
    assert.equal(executionCount, 0);
  });

  it("records model failures with secrets removed and the failing stage", async () => {
    generationError = "provider-secret failed; database-secret failed";
    const result = (await (await query({})).json()) as ObservatoryQueryResult;
    assert.equal(result.steps.find((step) => step.id === "generation")?.status, "failed");
    assert.match(result.error ?? "", /\[REDACTED\]/);
    const record = getQueryAudit(result.auditId)!;
    assert.equal(JSON.stringify(record).includes("provider-secret"), false);
    assert.equal(JSON.stringify(record).includes("database-secret"), false);
    assert.equal(executionCount, 0);
  });

  it("rejects forged rerun context and non-read-only SQL before execution", async () => {
    const original = (await (await query({})).json()) as ObservatoryQueryResult;
    for (const forged of [
      { connectionString: "mysql://attacker/db" },
      { permissionContext: { orgNos: ["other"] } },
      { sourceId: "another-source" },
      { workspace: "another-workspace" },
    ]) {
      const response = await rerun({
        parentAuditId: original.auditId,
        sql: "SELECT id FROM users",
        ...forged,
      });
      assert.equal(response.status, 400);
    }

    const before = executionCount;
    const writeResponse = await rerun({
      parentAuditId: original.auditId,
      sql: "DELETE FROM users",
      sqlSource: "original",
    });
    assert.equal(writeResponse.status, 400);
    const rejected = (await writeResponse.json()) as ObservatoryQueryResult;
    assert.match(rejected.error ?? "", /禁止/);
    assert.equal(executionCount, before);
    assert.equal(getQueryAudit(rejected.auditId)?.status, "failed");
    assert.equal(getQueryAudit(rejected.auditId)?.parentAuditId, original.auditId);
  });

  it("creates an immutable child audit and derives original/edited SQL source server-side", async () => {
    const parent = (await (await query({})).json()) as ObservatoryQueryResult;
    const parentBefore = getQueryAudit(parent.auditId)!;
    const original = (await (
      await rerun({
        parentAuditId: parent.auditId,
        sql: "SELECT id FROM users",
        sqlSource: "edited",
      })
    ).json()) as ObservatoryQueryResult;
    const originalRecord = getQueryAudit(original.auditId)!;
    assert.notEqual(original.auditId, parent.auditId);
    assert.equal(originalRecord.parentAuditId, parent.auditId);
    assert.equal(originalRecord.entrypoint, "rerun");
    assert.equal(originalRecord.source, "rerun");
    assert.equal(originalRecord.sqlSource, "original");
    assert.equal(originalRecord.originalQuestion, parentBefore.originalQuestion);
    assert.equal(originalRecord.executedSql, "SELECT id FROM users");
    assert.equal(originalRecord.steps.find((step) => step.id === "generation")?.status, "skipped");
    assert.equal(originalRecord.question, "查询前 100 条 users");
    assert.deepEqual(getQueryAudit(parent.auditId), parentBefore);

    const edited = (await (
      await rerun({
        parentAuditId: parent.auditId,
        sql: "SELECT id AS user_id FROM users",
        sqlSource: "edited",
      })
    ).json()) as ObservatoryQueryResult;
    assert.equal(getQueryAudit(edited.auditId)?.sqlSource, "edited");

    const detail = (await fetch(`${origin}/api/observatory/audits/${parent.auditId}`).then((res) =>
      res.json(),
    )) as {
      record: { id: string };
      parent: null;
      children: Array<{ id: string; parentAuditId: string }>;
    };
    assert.equal(detail.record.id, parent.auditId);
    assert.equal(detail.parent, null);
    assert.deepEqual(
      new Set(detail.children.map((child) => child.id)),
      new Set([original.auditId, edited.auditId]),
    );
    assert.ok(detail.children.every((child) => child.parentAuditId === parent.auditId));

    const chained = await rerun({
      parentAuditId: edited.auditId,
      sql: "SELECT id AS user_id FROM users",
    });
    assert.equal(chained.status, 400);

    const filtered = listQueryAudits({
      parentAuditId: parent.auditId,
      entrypoint: "rerun",
      source: "rerun",
      sqlSource: "edited",
    });
    assert.equal(filtered.total, 1);
    assert.equal(filtered.records[0]?.id, edited.auditId);
  });

  it("marks database errors at execution and skips output", async () => {
    executionError = "database-secret: connection refused";
    const result = (await (await query({})).json()) as ObservatoryQueryResult;
    assert.equal(result.steps.find((step) => step.id === "execution")?.status, "failed");
    assert.equal(result.steps.find((step) => step.id === "output")?.status, "skipped");
    assert.match(result.error ?? "", /connection refused/);
    assert.equal(result.error?.includes("database-secret"), false);
  });

  it("treats zero rows as a successful completed query", async () => {
    resultRows = [];
    const result = (await (await query({})).json()) as ObservatoryQueryResult;
    assert.deepEqual(result.rows, []);
    assert.equal(result.steps.at(-1)?.status, "succeeded");
    assert.equal(getQueryAudit(result.auditId)?.rowCount, 0);
    assert.equal(getQueryAudit(result.auditId)?.status, "succeeded");
  });

  it("audits missing sources and preserves the JSON 404 response", async () => {
    const response = await query({ sourceId: "missing-source" });
    assert.equal(response.status, 404);
    const result = (await response.json()) as ObservatoryQueryResult;
    const record = getQueryAudit(result.auditId)!;
    assert.equal(record.sourceId, "missing-source");
    assert.equal(record.steps[0]?.status, "failed");
    assert.ok(record.steps.slice(1).every((step) => step.status === "skipped"));
  });

  it("filters, paginates, and reads persisted audit details after reopening SQLite", async () => {
    closeDb();
    const filters = new URLSearchParams({ sourceId, status: "failed", limit: "1", offset: "1" });
    const response = await fetch(`${origin}/api/observatory/audits?${filters}`);
    const page = (await response.json()) as {
      records: { id: string; status: string }[];
      total: number;
    };
    assert.ok(page.total >= 3);
    assert.equal(page.records.length, 1);
    assert.equal(page.records[0]?.status, "failed");
    assert.equal("steps" in page.records[0]!, false);
    const detail = (await fetch(`${origin}/api/observatory/audits/${page.records[0]!.id}`).then(
      (res) => res.json(),
    )) as { record: { steps: unknown[] } };
    assert.equal(detail.record.steps.length, 7);
    const search = listQueryAudits({ sourceId, search: "危险 SQL" });
    assert.equal(search.total, 1);
    assert.equal(search.records[0]?.question, "危险 SQL 前 100 条");
    assert.equal(listQueryAudits({ sourceId: "missing-source" }).total, 1);
  });

  it("rejects invalid audit filters and nonexistent details", async () => {
    for (const params of ["limit=101", "offset=-1", "limit=NaN", "status=unknown"]) {
      const response = await fetch(`${origin}/api/observatory/audits?${params}`);
      assert.equal(response.status, 400);
    }
    assert.equal((await fetch(`${origin}/api/observatory/audits/missing`)).status, 404);
    assert.equal((await query({ question: " " })).status, 400);
  });
});
