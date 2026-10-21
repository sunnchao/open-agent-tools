import { createHash } from "node:crypto";
import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions/completions";
import { runSchemaText2Sql, type HistoryTurn } from "../oneapiDemo/text2sql.js";
import type { SchemaSource } from "../schemaSources/store.js";

export type SqlQuestionSource = Pick<SchemaSource, "id" | "name" | "connector">;

export function sqlQuestionToolName(sourceId: string): string {
  return `ask_sql_${createHash("sha256").update(sourceId).digest("hex").slice(0, 32)}`;
}

export function buildSqlQuestionTools(sources: SqlQuestionSource[]): ChatCompletionFunctionTool[] {
  return sources.map((source) => ({
    type: "function",
    function: {
      name: sqlQuestionToolName(source.id),
      description:
        `向 SQL 问数模块提交关于数据源「${source.name}」（${source.connector}）的自然语言问题。` +
        "模块负责检索 Schema、生成并校验只读 SQL、执行和记录审计。" +
        "question 应包含用户明确提出的查询条件和条数，不要编写 SQL 或猜测口径。" +
        "返回 clarifying 时向用户追问，等待补充后再调用。",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "要查询的自然语言问题，保留用户的条件和条数" },
        },
        required: ["question"],
        additionalProperties: false,
      },
    },
  }));
}

export async function runChatSqlQuestion(
  source: SqlQuestionSource,
  question: unknown,
  history: HistoryTurn[] = [],
  runQuery: typeof runSchemaText2Sql = runSchemaText2Sql,
) {
  if (typeof question !== "string" || !question.trim()) {
    throw new Error("SQL 问数需要非空的自然语言 question");
  }
  const result = await runQuery(source.id, question.trim(), history.slice(-6));
  if (result.error) {
    throw new Error(`${result.error}（审计 ID：${result.auditId}）`);
  }
  const props = {
    sourceId: result.sourceId,
    sourceName: source.name,
    question: result.question,
    sql: result.sql,
    rows: result.rows ?? [],
    rowCount: result.rows?.length ?? 0,
    auditId: result.auditId,
    selectedTables: result.selectedTables,
    steps: result.steps.map(({ input: _input, output: _output, ...step }) => step),
    durationMs: result.durationMs,
    usage: result.usage,
    truncated: result.truncated === true,
    ...(result.clarifying ? { clarifying: result.clarifying } : {}),
  };
  return {
    ok: true as const,
    ui: {
      type: "sql_result",
      content: result.clarifying ?? `查询返回 ${props.rowCount} 行。`,
      props,
    },
  };
}
