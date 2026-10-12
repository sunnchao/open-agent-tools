import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { effectiveNodeConfig } from "@open-agent-tools/workflow-contracts";
import type { ObservatoryQueryResult } from "../oneapiDemo/text2sql.js";
import { runWorkflowSqlQuery, WorkflowSqlError, type WorkflowSqlResult } from "./sqlQuery.js";
import { executeWorkflow, executeWorkflowNodeTest, type WorkflowEvent } from "./executor.js";

const queryResult = (values: Partial<ObservatoryQueryResult> = {}): ObservatoryQueryResult => ({
  sourceId: "ops",
  question: "用户",
  auditId: "audit-1",
  steps: [{ id: "execution", label: "执行查询", status: "succeeded", durationMs: 5 }],
  selectedTables: ["users"],
  schemaPrompt: "",
  graph: { nodes: [], edges: [], stats: { entities: 0, relations: 0 } },
  seeds: [],
  formattedGraph: "",
  sql: "SELECT id FROM users LIMIT 10",
  rows: [{ id: 1 }],
  durationMs: 10,
  ...values,
});

const sqlResult = (): WorkflowSqlResult => ({
  sourceId: "ops",
  sql: "SELECT id FROM users LIMIT 10",
  rows: [{ id: 1, api_key: "secret-value" }],
  rowCount: 1,
  auditId: "audit-1",
  selectedTables: ["users"],
  steps: [],
  durationMs: 10,
  truncated: false,
});

describe("workflow SQL query adapter", () => {
  it("applies default row counts only when the question does not specify them", async () => {
    for (const query of ["查询用户", "查询前 5 条用户", "查询全部用户"]) {
      let received = "";
      const result = await runWorkflowSqlQuery(
        { query, sourceId: "ops", maxRows: 10 },
        async (sourceId, question) => {
          assert.equal(sourceId, "ops");
          received = question;
          return queryResult();
        },
      );
      assert.equal(received, query === "查询用户" ? "查询用户\n返回条数：最多 10 条。" : query);
      assert.equal(result.rowCount, 1);
      assert.equal(result.auditId, "audit-1");
      assert.deepEqual(result.steps, queryResult().steps);
    }
  });

  it("keeps zero-row queries successful and exposes truncated results", async () => {
    const empty = await runWorkflowSqlQuery({ query: "前 10 条用户", maxRows: 10 }, async () =>
      queryResult({ rows: [] }),
    );
    assert.equal(empty.rowCount, 0);
    assert.deepEqual(empty.rows, []);
    const capped = await runWorkflowSqlQuery({ query: "查询全部用户", maxRows: 10 }, async () =>
      queryResult({ truncated: true }),
    );
    assert.equal(capped.truncated, true);
  });

  it("retains audit IDs, partial SQL, and step details on failures and clarifications", async () => {
    for (const failure of [
      { error: "SQL 不允许跨 Schema 查询" },
      { clarifying: "请补充时间范围" },
    ]) {
      await assert.rejects(
        runWorkflowSqlQuery({ query: "前 10 条用户", maxRows: 10 }, async () =>
          queryResult(failure),
        ),
        (error: unknown) => {
          assert.ok(error instanceof WorkflowSqlError);
          assert.match(error.message, /audit-1/);
          assert.equal(error.result.sql, queryResult().sql);
          assert.deepEqual(error.result.steps, queryResult().steps);
          return true;
        },
      );
    }
  });

  it("prevents a new query stage after cancellation and preserves failure updates", async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    const step = { id: "execution" as const, label: "执行查询", status: "running" as const };
    let executed = false;
    await assert.rejects(
      runWorkflowSqlQuery(
        { query: "前 10 条用户", maxRows: 10, signal },
        async (_sourceId, _question, _history, onProgress) => {
          controller.abort();
          try {
            onProgress?.({ type: "step", auditId: "audit-1", step });
            executed = true;
          } catch {
            onProgress?.({
              type: "step",
              auditId: "audit-1",
              step: { ...step, status: "failed", message: "SQL 问数已取消" },
            });
          }
          return queryResult({ error: "SQL 问数已取消" });
        },
      ),
      /已取消/,
    );
    assert.equal(executed, false);
    await assert.rejects(
      runWorkflowSqlQuery({ query: "前 10 条用户", maxRows: 10, signal }, async () => {
        throw new Error("must not run");
      }),
      /已取消/,
    );
  });
});

describe("workflow SQL node execution", () => {
  it("interpolates questions and passes declared SQL outputs to downstream nodes", async () => {
    const events: WorkflowEvent[] = [];
    const outputs = await executeWorkflow(
      {
        input: { question: "最近 10 条订单" },
        nodes: [
          {
            id: "s",
            kind: "start",
            config: { runVariables: [{ name: "question", type: "string" }] },
          },
          {
            id: "q",
            kind: "sql",
            config: {
              ...effectiveNodeConfig("sql"),
              sourceId: "ops",
              query: "{{query}}",
              maxRows: 10,
              inputs: [{ name: "query", source: { type: "run", variable: "question" } }],
            },
          },
          {
            id: "e",
            kind: "end",
            config: {
              inputs: ["rows", "sql", "rowCount", "auditId"].map((name) => ({
                name,
                source: { type: "node", nodeId: "q", output: name },
              })),
              outputs: [{ name: "answer", selector: "$inputs" }],
            },
          },
        ],
        edges: [
          { source: "s", target: "q" },
          { source: "q", target: "e" },
        ],
      },
      (event) => events.push(event),
      {
        sqlQuery: async (input) => {
          assert.equal(input.query, "最近 10 条订单");
          assert.equal(input.sourceId, "ops");
          assert.equal(input.maxRows, 10);
          assert.ok(input.signal);
          return sqlResult();
        },
      },
    );
    assert.equal((outputs.e?.answer as Record<string, unknown>).rowCount, 1);
    assert.equal((outputs.e?.answer as Record<string, unknown>).auditId, "audit-1");
    assert.equal(
      events.find((event) => event.type === "node_result" && event.nodeId === "q")?.status,
      "success",
    );
    assert.equal(JSON.stringify(events).includes("secret-value"), false);
    assert.ok(JSON.stringify(events).includes("[REDACTED]"));
  });

  it("supports single-node tests with default sources and retains failed execution details", async () => {
    const node = {
      id: "q",
      kind: "sql" as const,
      config: {
        ...effectiveNodeConfig("sql"),
        query: "最近 10 条订单",
      },
    };
    const success = await executeWorkflowNodeTest(
      { node, inputs: {} },
      {
        sqlQuery: async (input) => {
          assert.equal(input.sourceId, undefined);
          assert.equal(input.maxRows, 100);
          return sqlResult();
        },
      },
    );
    assert.equal(success.status, "success");
    assert.equal(success.outputs.auditId, "audit-1");
    const failure = await executeWorkflowNodeTest(
      { node, inputs: {} },
      {
        sqlQuery: async () => {
          throw new WorkflowSqlError("SQL 校验失败", sqlResult());
        },
      },
    );
    assert.equal(failure.status, "error");
    assert.equal((failure.result as WorkflowSqlResult).auditId, "audit-1");
    assert.deepEqual(failure.outputs, {});
  });

  it("rejects empty queries and stops downstream execution when SQL fails", async () => {
    const empty = await executeWorkflowNodeTest(
      {
        node: { id: "q", kind: "sql", config: { query: " " } },
        inputs: {},
      },
      {
        sqlQuery: async () => {
          throw new Error("must not run");
        },
      },
    );
    assert.equal(empty.status, "error");
    assert.match(empty.error ?? "", /需要配置问题/);
    const events: WorkflowEvent[] = [];
    await assert.rejects(
      executeWorkflow(
        {
          nodes: [
            { id: "q", kind: "sql", config: { query: "最近 10 条订单" } },
            { id: "e", kind: "end" },
          ],
          edges: [{ source: "q", target: "e" }],
          input: {},
        },
        (event) => events.push(event),
        {
          sqlQuery: async () => {
            throw new WorkflowSqlError("需要补充查询口径", sqlResult());
          },
        },
      ),
      /需要补充/,
    );
    assert.equal(
      events.some((event) => event.type === "node_start" && event.nodeId === "e"),
      false,
    );
    assert.equal(
      (events.find((event) => event.type === "node_result")?.result as WorkflowSqlResult).auditId,
      "audit-1",
    );
  });
});
