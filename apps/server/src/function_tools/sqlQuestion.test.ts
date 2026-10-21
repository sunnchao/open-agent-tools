import assert from "node:assert/strict";
import { it } from "node:test";
import type { HistoryTurn, ObservatoryQueryResult } from "../oneapiDemo/text2sql.js";
import { executeTool } from "./index.js";
import { buildSqlQuestionTools, runChatSqlQuestion, sqlQuestionToolName } from "./sqlQuestion.js";

const source = { id: "ops", name: "运营库", connector: "mysql" as const };
const queryResult = (values: Partial<ObservatoryQueryResult> = {}): ObservatoryQueryResult => ({
  usage: { requests: 1, inputTokens: 20, outputTokens: 5, totalTokens: 25, toolCalls: 0, toolErrors: 0 },
  auditId: "audit-1",
  sourceId: source.id,
  question: "前 10 条用户",
  selectedTables: ["users"],
  schemaPrompt: "",
  graph: { nodes: [], edges: [], stats: { entities: 0, relations: 0 } },
  seeds: [],
  formattedGraph: "",
  steps: [],
  durationMs: 10,
  rows: [{ id: 1 }],
  sql: "SELECT id FROM users LIMIT 10",
  ...values,
});

it("exposes natural-language SQL questions only for the selected source identities", () => {
  assert.deepEqual(buildSqlQuestionTools([]), []);
  const [tool] = buildSqlQuestionTools([source]);
  assert.ok(tool);
  assert.match(tool.function.description ?? "", /运营库/);
  assert.deepEqual(tool.function.parameters?.required, ["question"]);
  assert.equal("sql" in (tool.function.parameters?.properties as object), false);
  assert.match(tool.function.name, /^ask_sql_[a-f0-9]+$/);
  assert.ok(tool.function.name.length <= 64);
  assert.notEqual(sqlQuestionToolName("source.a"), sqlQuestionToolName("source_a"));
  assert.notEqual(sqlQuestionToolName("a".repeat(100)), sqlQuestionToolName(`${"a".repeat(100)}b`));
});

it("forwards the bound source, question, and recent conversation to the SQL question module", async () => {
  const history: HistoryTurn[] = Array.from({ length: 10 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `turn ${index}`,
  }));
  const result = await runChatSqlQuestion(
    source,
    " 前 10 条用户 ",
    history,
    async (id, question, received) => {
      assert.equal(id, source.id);
      assert.equal(question, "前 10 条用户");
      assert.deepEqual(received, history.slice(-6));
      return queryResult();
    },
  );
  assert.equal(result.ui.props.sourceName, "运营库");
  assert.equal(result.ui.props.auditId, "audit-1");
  assert.deepEqual(result.ui.props.rows, [{ id: 1 }]);
  assert.equal(result.ui.props.sql, "SELECT id FROM users LIMIT 10");
});

it("keeps full audit payloads out of the chat result while preserving step summaries", async () => {
  const result = await runChatSqlQuestion(source, "前 10 条用户", [], async () =>
    queryResult({
      steps: [
        {
          id: "generation",
          label: "生成 SQL",
          status: "succeeded",
          durationMs: 10,
          input: { schemaPrompt: "large-schema-payload" },
          output: { sql: "SELECT id FROM users LIMIT 10" },
        },
      ],
    }),
  );
  assert.equal(result.ui.props.steps[0]?.status, "succeeded");
  assert.equal(JSON.stringify(result).includes("large-schema-payload"), false);
  assert.deepEqual(result.ui.props.rows, [{ id: 1 }]);
});

it("preserves clarification, empty results, and truncation from the module", async () => {
  for (const values of [
    { rows: [], clarifying: "请补充查询条数", sql: undefined },
    { rows: [], truncated: true },
  ]) {
    const result = await runChatSqlQuestion(source, "用户", [], async () => queryResult(values));
    assert.deepEqual(result.ui.props.rows, []);
    assert.equal(result.ui.props.clarifying, values.clarifying);
    assert.equal(result.ui.props.truncated, values.truncated === true);
    assert.equal(result.ui.props.auditId, "audit-1");
  }
});

it("rejects old SQL arguments and tools for unbound sources before querying", async () => {
  await assert.rejects(
    executeTool(sqlQuestionToolName("unbound"), '{"question":"用户"}', { schemaSources: [source] }),
    /unknown tool/,
  );
  await assert.rejects(
    executeTool(sqlQuestionToolName(source.id), '{"sql":"SELECT id FROM users"}', {
      schemaSources: [source],
    }),
    /自然语言 question/,
  );
  await assert.rejects(
    executeTool("query_sql_ops", '{"sql":"SELECT id FROM users"}', { schemaSources: [source] }),
    /unknown tool/,
  );
  await assert.rejects(runChatSqlQuestion(source, " "), /非空/);
  await assert.rejects(
    runChatSqlQuestion(source, "用户", [], async () => queryResult({ error: "校验失败" })),
    /校验失败.*audit-1/,
  );
});
