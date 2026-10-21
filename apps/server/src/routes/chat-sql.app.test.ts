import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { createApp } from "../app.js";
import { closeDb, getSession } from "../db.js";
import { sqlQuestionToolName } from "../function_tools/sqlQuestion.js";
import { getQueryAudit } from "../observatory/queryAudit.js";
import { OpenAIChatClient } from "../providers/clients/openai-chat.js";
import type { LlmClient } from "../providers/clients/types.js";
import { createProvider, setDefaultProvider } from "../providers/store.js";
import { invalidateSchemaSource } from "../schemaSources/runtime.js";
import { createSchemaSource, updateSchemaSource } from "../schemaSources/store.js";
import { summarizeUsage } from "../usage.js";
import { createWorkspace } from "../workspace.js";

const requireDatabase = createRequire(
  new URL("../../../../packages/database/package.json", import.meta.url),
);
const { PromisePool } = requireDatabase("mysql2/promise") as {
  PromisePool: { prototype: { query: (...args: unknown[]) => Promise<unknown> } };
};
const { Pool } = requireDatabase("pg") as {
  Pool: {
    prototype: {
      query: (...args: unknown[]) => Promise<unknown>;
      connect: () => Promise<unknown>;
    };
  };
};

type StreamRequest = Parameters<LlmClient["streamChat"]>[0];
interface SqlProps {
  sourceId: string;
  sourceName: string;
  rows: Record<string, unknown>[];
  auditId: string;
  sql?: string;
  clarifying?: string;
}
interface Event {
  tool_result?: { error?: string; name: string; ui?: { type: string; props: SqlProps } };
  error?: string;
  done?: boolean;
  status?: string;
}
let server: Server;
let origin: string;
let dir: string;
let sourceId: string;
let pgSourceId: string;
let disabledSourceId: string;
let calls: Array<{ id: string; name: string; arguments: string }>;
let streamRequests: StreamRequest[];
let sqlPrompts: string[];
let executions: string[];
let mysqlSql: string;
let executionError: string | null;
let streamError: { afterDelta?: string; message: string } | null;
const previousEnv = Object.fromEntries(
  [
    "SQLITE_PATH",
    "CONFIG_SECRETS_ENCRYPTION_KEY",
    "SCHEMA_SOURCE_URL",
    "REPORT_DATABASE_URL",
    "AI_QUERY_PROVIDER_ID",
    "AI_QUERY_MODEL",
  ].map((key) => [key, process.env[key]]),
);

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "chat-sql-api-test-"));
  process.env.SQLITE_PATH = join(dir, "test.sqlite");
  process.env.CONFIG_SECRETS_ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  delete process.env.SCHEMA_SOURCE_URL;
  delete process.env.REPORT_DATABASE_URL;
  delete process.env.AI_QUERY_MODEL;
  sourceId = createSchemaSource({
    name: "运营库",
    connectionString: "mysql://readonly:database-secret@localhost/demo",
  }).id;
  pgSourceId = createSchemaSource({
    name: "分析库",
    connectionString: "postgresql://readonly:pg-secret@localhost/analytics",
    schemaName: "reporting",
  }).id;
  disabledSourceId = createSchemaSource({
    name: "停用库",
    connectionString: "mysql://readonly:disabled-secret@localhost/disabled",
    enabled: false,
  }).id;
  const provider = createProvider({
    name: "问数模型",
    baseUrl: "http://localhost:1/v1",
    apiKey: "provider-secret",
    models: ["test-model"],
  });
  setDefaultProvider(provider.id);
  process.env.AI_QUERY_PROVIDER_ID = provider.id;

  // Keep the catalog, graph, validation, execution dispatch, and audit store real.
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
    executions.push(sql);
    if (executionError) throw new Error(executionError);
    return [[{ id: 1 }], []];
  });
  mock.method(Pool.prototype, "query", async (sql: string) => {
    if (sql.includes("information_schema.tables t")) {
      return {
        rows: [
          {
            table_schema: "reporting",
            table_name: "events",
            table_comment: "事件",
            approx_rows: 2,
          },
        ],
      };
    }
    if (sql.includes("information_schema.columns c")) {
      return {
        rows: [
          {
            table_schema: "reporting",
            table_name: "events",
            column_name: "id",
            column_type: "integer",
            is_nullable: "NO",
            column_default: null,
            column_comment: "编号",
            ordinal_position: 1,
          },
        ],
      };
    }
    return { rows: [] };
  });
  mock.method(Pool.prototype, "connect", async () => ({
    query: async (sql: string) => {
      if (/^SELECT/i.test(sql)) executions.push(sql);
      return { rows: /^SELECT/i.test(sql) ? [{ id: 2 }] : [] };
    },
    release: () => undefined,
  }));
  mock.method(
    OpenAIChatClient.prototype,
    "complete",
    async (request: Parameters<LlmClient["complete"]>[0]) => {
      const prompt = request.messages.map((message) => message.content).join("\n");
      sqlPrompts.push(prompt);
      return {
        tokenUsage: { inputTokens: 50, outputTokens: 10 },
        content: JSON.stringify({
          sql: prompt.includes("你是“分析库”")
            ? 'SELECT id FROM "reporting"."events" LIMIT 10'
            : mysqlSql,
        }),
      };
    },
  );
  mock.method(OpenAIChatClient.prototype, "streamChat", async (request: StreamRequest) => {
    streamRequests.push(request);
    if (streamError) {
      if (streamError.afterDelta) request.callbacks.onDelta(streamError.afterDelta);
      throw new Error(streamError.message);
    }
    if (streamRequests.length === 1 && calls.length) return {
      content: "", toolCalls: calls, tokenUsage: { inputTokens: 100, outputTokens: 20 },
    };
    request.callbacks.onDelta("已完成问数");
    return {
      content: "已完成问数", toolCalls: [], tokenUsage: { inputTokens: 100, outputTokens: 20 },
    };
  });
  server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  calls = [
    {
      id: "sql-call",
      name: sqlQuestionToolName(sourceId),
      arguments: '{"question":"查询前 10 条 users"}',
    },
  ];
  streamRequests = [];
  sqlPrompts = [];
  executions = [];
  mysqlSql = "SELECT id FROM users LIMIT 10";
  executionError = null;
  streamError = null;
});

after(async () => {
  server.close();
  await once(server, "close");
  invalidateSchemaSource(sourceId);
  invalidateSchemaSource(pgSourceId);
  closeDb();
  mock.restoreAll();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

async function request(body: Record<string, unknown> = {}, workspaceId?: string) {
  return fetch(`${origin}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(workspaceId ? { "x-workspace-id": workspaceId } : {}) },
    body: JSON.stringify({
      messages: [{ role: "user", content: "查询前 10 条 users" }],
      resources: { sqlSources: [sourceId] },
      ...body,
    }),
  });
}
async function chat(body: Record<string, unknown> = {}, workspaceId?: string) {
  const response = await request(body, workspaceId);
  assert.equal(response.status, 200);
  const wire = await response.text();
  const events = wire
    .split("\n\n")
    .filter((event) => event.startsWith("data:"))
    .map((event) => JSON.parse(event.slice(6)) as Event);
  assert.equal(events.at(-1)?.done, true);
  return { events, wire, tool: events.find((event) => event.tool_result)?.tool_result };
}

describe("Web chat SQL question integration", () => {
  it("displays nested SQL usage and counts each model request once in its workspace", async () => {
    const workspace = createWorkspace({ name: "SQL usage" });
    const { wire, tool } = await chat({ sessionId: "usage-chat" }, workspace.id);
    const done = wire.split("\n\n").filter((line) => line.includes('"done":true')).at(-1)!;
    const final = JSON.parse(done.slice(6)) as { usage: { requests: number; totalTokens: number } };
    assert.equal(final.usage.requests, 3);
    assert.equal(final.usage.totalTokens, 300);
    const summary = summarizeUsage(undefined, undefined, workspace.id);
    assert.equal(summary.totals.requests, 3);
    assert.equal(summary.totals.totalTokens, 300);
    assert.equal(summary.totals.toolCalls, 1);
    assert.equal(summary.bySource.find((entry) => entry.source === "sql_query")?.requests, 1);
    assert.equal(summary.bySource.find((entry) => entry.source === "web_chat")?.requests, 2);
    const audit = getQueryAudit(tool!.ui!.props.auditId);
    assert.equal(audit?.workspace, workspace.id);
    assert.equal(audit?.usage?.totalTokens, 60);
  });

  it("removes SQL tools and schema injection when no SQL source is bound, including legacy env configuration", async () => {
    process.env.REPORT_DATABASE_URL = "mysql://readonly:legacy-secret@localhost/legacy";
    try {
      calls = [];
      await chat({ resources: undefined });
      assert.deepEqual(
        streamRequests[0]?.tools?.map((tool) => tool.name),
        ["get_financial_reports"],
      );
      assert.deepEqual(streamRequests[0]?.messages, [
        { role: "user", content: "查询前 10 条 users" },
      ]);
      assert.deepEqual(executions, []);
      assert.deepEqual(sqlPrompts, []);
    } finally {
      delete process.env.REPORT_DATABASE_URL;
    }
  });

  it("runs the actual SQL question module, returns rows, persists tool output, and exposes the shared audit", async () => {
    const { tool, wire } = await chat({ sessionId: "sql-chat" });
    const props = tool!.ui!.props;
    assert.equal(tool?.name, "SQL 问数 · 运营库");
    assert.equal(tool?.ui?.type, "sql_result");
    assert.deepEqual(props.rows, [{ id: 1 }]);
    assert.equal(props.sourceId, sourceId);
    assert.equal(props.sql, mysqlSql);
    assert.equal(sqlPrompts.length, 1);
    assert.match(sqlPrompts[0]!, /users/);
    const audit = getQueryAudit(props.auditId)!;
    assert.equal(audit.status, "succeeded");
    assert.equal(audit.rowCount, 1);
    assert.equal(audit.sourceName, "运营库");
    assert.deepEqual(
      audit.steps.map((step) => step.status),
      Array(7).fill("succeeded"),
    );
    const auditResponse = await fetch(`${origin}/api/observatory/audits/${props.auditId}`);
    assert.equal(auditResponse.status, 200);
    assert.ok(
      getSession("sql-chat")?.messages.some(
        (message) => message.role === "tool" && message.content.includes(props.auditId),
      ),
    );
    assert.equal(/database-secret|provider-secret/.test(wire), false);
    assert.equal(
      streamRequests[0]?.tools?.some((tool) => tool.name.startsWith("query_sql")),
      false,
    );
  });

  it("queries two bound engines independently in one turn", async () => {
    calls.push({
      id: "pg-call",
      name: sqlQuestionToolName(pgSourceId),
      arguments: '{"question":"查询前 10 条 events"}',
    });
    const { events } = await chat({ resources: { sqlSources: [sourceId, pgSourceId] } });
    const results = events.flatMap((event) =>
      event.tool_result?.ui ? [event.tool_result.ui.props] : [],
    );
    assert.deepEqual(
      results.map((result) => result.sourceId),
      [sourceId, pgSourceId],
    );
    assert.deepEqual(
      results.map((result) => result.rows),
      [[{ id: 1 }], [{ id: 2 }]],
    );
    assert.equal(executions.length, 2);
    assert.match(executions[1]!, /"reporting"."events"/);
    assert.equal(getQueryAudit(results[1]!.auditId)?.sourceName, "分析库");
  });

  it("returns module clarification, then continues from the latest user reply rather than the assistant suggestion", async () => {
    calls[0]!.arguments = '{"question":"查询 users"}';
    const first = await chat({ messages: [{ role: "user", content: "查询 users" }] });
    assert.match(first.tool?.ui?.props.clarifying ?? "", /查询多少条/);
    assert.equal(sqlPrompts.length, 0);
    assert.deepEqual(executions, []);
    assert.equal(streamRequests.at(-1)?.tools, undefined);
    assert.equal(getQueryAudit(first.tool!.ui!.props.auditId)?.status, "clarifying");
    streamRequests = [];
    calls[0]!.arguments = '{"question":"10"}';
    const second = await chat({
      messages: [
        { role: "user", content: "查询 users" },
        { role: "assistant", content: first.tool!.ui!.props.clarifying },
        { role: "user", content: "10" },
      ],
    });
    assert.deepEqual(second.tool?.ui?.props.rows, [{ id: 1 }]);
    assert.match(sqlPrompts[0]!, /用户要求 10 条/);
    assert.match(sqlPrompts[0]!, /用户: 查询 users/);
    assert.equal(getQueryAudit(second.tool!.ui!.props.auditId)?.rowLimit?.kind, "limited");
  });

  it("rejects invalid or disabled bindings before streaming", async () => {
    for (const sqlSources of [["missing"], [disabledSourceId], "invalid"]) {
      const response = await request({ resources: { sqlSources } });
      assert.equal(response.status, 400);
      assert.match(((await response.json()) as { error: string }).error, /sqlSources/);
    }
    assert.equal(streamRequests.length, 0);
  });

  it("refuses unbound sources and the removed query_sql even when requested by the model", async () => {
    for (const name of [sqlQuestionToolName(pgSourceId), "query_sql"]) {
      streamRequests = [];
      calls[0]!.name = name;
      const { tool } = await chat();
      assert.match(tool?.error ?? "", /unknown tool/);
    }
    assert.deepEqual(sqlPrompts, []);
    assert.deepEqual(executions, []);
  });

  it("returns schema validation errors through tool SSE and records failed audits", async () => {
    for (const sql of [
      "DELETE FROM users",
      "SELECT * FROM private.users",
      "SELECT * FROM other_table",
    ]) {
      streamRequests = [];
      mysqlSql = sql;
      const { tool } = await chat();
      assert.match(tool?.error ?? "", /禁止|当前 Schema 源/);
      const auditId = tool!.error!.match(/审计 ID：([^）]+)/)?.[1];
      assert.ok(auditId);
      const audit = getQueryAudit(auditId)!;
      assert.equal(audit.status, "failed");
      assert.equal(audit.steps.find((step) => step.id === "validation")?.status, "failed");
    }
    assert.equal(executions.length, 0);
  });

  it("redacts database and provider credentials in execution errors sent to chat", async () => {
    executionError = "mysql://readonly:database-secret@localhost/demo provider-secret";
    const { wire, tool } = await chat();
    assert.match(tool?.error ?? "", /审计 ID/);
    assert.equal(wire.includes("database-secret"), false);
    assert.equal(wire.includes("provider-secret"), false);
    assert.equal(executions.length, 1);
  });

  it("keeps an errored assistant message from being rewritten as complete", async () => {
    calls = [];
    streamError = { afterDelta: "partial answer", message: "provider exploded" };
    const { events } = await chat({ sessionId: "error-session", userMessage: { content: "查询" } });
    assert.equal(events.some((event) => event.error === "provider exploded"), true);
    assert.equal(events.at(-1)?.status, "error");

    const session = getSession("error-session");
    const assistant = session?.messages.find((message) => message.role === "assistant");
    assert.equal(assistant?.status, "error");
    assert.equal(assistant?.content, "partial answer");
  });

  it("rechecks enabled state at execution time", async () => {
    calls[0]!.name = sqlQuestionToolName(pgSourceId);
    const streamMock = mock.method(
      OpenAIChatClient.prototype,
      "streamChat",
      async (request: StreamRequest) => {
        streamRequests.push(request);
        if (streamRequests.length === 1) {
          updateSchemaSource(pgSourceId, { enabled: false });
          return { content: "", toolCalls: calls };
        }
        return { content: "", toolCalls: [] };
      },
    );
    try {
      const { tool } = await chat({ resources: { sqlSources: [pgSourceId] } });
      assert.match(tool?.error ?? "", /not found or disabled.*审计 ID/);
      assert.equal(executions.length, 0);
    } finally {
      updateSchemaSource(pgSourceId, { enabled: true });
      streamMock.mock.restore();
    }
  });
});
