import { runSchemaText2Sql, type ObservatoryQueryResult } from "../../query/text2sql/text2sql.js";
import { detectRowLimitIntent } from "../../query/schema-inject.js";
import type { QueryStep } from "../../query/audit/queryAudit.js";

export interface WorkflowSqlResult {
  sourceId: string;
  sql: string;
  rows: Record<string, unknown>[];
  rowCount: number;
  auditId: string;
  selectedTables: string[];
  steps: QueryStep[];
  durationMs: number;
  truncated: boolean;
  error?: string;
  clarifying?: string;
}

export class WorkflowSqlError extends Error {
  constructor(
    message: string,
    public readonly result: WorkflowSqlResult,
  ) {
    super(message);
  }
}

export async function runWorkflowSqlQuery(
  input: { sourceId?: string; query: string; maxRows: number; signal?: AbortSignal },
  runQuery: typeof runSchemaText2Sql = runSchemaText2Sql,
): Promise<WorkflowSqlResult> {
  if (input.signal?.aborted) throw new Error("SQL 问数已取消");
  const question =
    detectRowLimitIntent(input.query).kind === "unspecified"
      ? `${input.query}\n返回条数：最多 ${input.maxRows} 条。`
      : input.query;
  const queried: ObservatoryQueryResult = await runQuery(input.sourceId, question, [], (event) => {
    // Stop before starting another stage after the workflow times out or is cancelled.
    if (input.signal?.aborted && event.type === "step" && event.step.status === "running") {
      throw new Error("SQL 问数已取消");
    }
  });
  const result: WorkflowSqlResult = {
    sourceId: queried.sourceId,
    sql: queried.sql ?? "",
    rows: queried.rows ?? [],
    rowCount: queried.rows?.length ?? 0,
    auditId: queried.auditId,
    selectedTables: queried.selectedTables,
    steps: queried.steps,
    durationMs: queried.durationMs,
    truncated: queried.truncated === true,
    ...(queried.error ? { error: queried.error } : {}),
    ...(queried.clarifying ? { clarifying: queried.clarifying } : {}),
  };
  if (queried.error || queried.clarifying) {
    throw new WorkflowSqlError(
      `${queried.error ?? `需要补充查询口径：${queried.clarifying}`}（审计 ID：${queried.auditId}）`,
      result,
    );
  }
  if (input.signal?.aborted) throw new WorkflowSqlError("SQL 问数已取消", result);
  return result;
}
