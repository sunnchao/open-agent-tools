import { auditFilterClause } from "../observatory/queryAuditFilter.js";
import { openDb } from "../db.js";
import { listQueryAudits, type QueryAuditFilters } from "../observatory/queryAudit.js";
import type { CsvColumn } from "./csv.js";
import { exportRowLimit } from "./usageExport.js";

export interface AuditExportRow {
  id: string;
  actor: string;
  actor_type: string;
  entrypoint: string;
  source: string;
  sql_source: string;
  status: string;
  original_question: string;
  generated_sql: string;
  executed_sql: string;
  row_count: number | null;
  duration_ms: number;
  started_at: string;
  finished_at: string;
  error: string;
  workspace: string;
  parent_audit_id: string;
}

export const AUDIT_EXPORT_COLUMNS: Array<CsvColumn<AuditExportRow>> = [
  { header: "id", value: (row) => row.id },
  { header: "actor", value: (row) => row.actor },
  { header: "actor_type", value: (row) => row.actor_type },
  { header: "entrypoint", value: (row) => row.entrypoint },
  { header: "source", value: (row) => row.source },
  { header: "sql_source", value: (row) => row.sql_source },
  { header: "status", value: (row) => row.status },
  { header: "original_question", value: (row) => row.original_question },
  { header: "generated_sql", value: (row) => row.generated_sql },
  { header: "executed_sql", value: (row) => row.executed_sql },
  { header: "row_count", value: (row) => row.row_count },
  { header: "duration_ms", value: (row) => row.duration_ms },
  { header: "started_at", value: (row) => row.started_at },
  { header: "finished_at", value: (row) => row.finished_at },
  { header: "error", value: (row) => row.error },
  { header: "workspace", value: (row) => row.workspace },
  { header: "parent_audit_id", value: (row) => row.parent_audit_id },
];

interface AuditExportDbRow {
  id: string;
  actor: string;
  actor_type: string;
  entrypoint: string;
  source: string;
  sql_source: string;
  status: string;
  question: string;
  original_question: string;
  generated_sql: string | null;
  executed_sql: string | null;
  row_count: number | null;
  duration_ms: number;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  workspace: string;
  parent_audit_id: string | null;
}

/**
 * 按 QueryAuditFilters 读取审计明细。
 *
 * 直接读 `observatory_query_audits` 的列(而不是列表页解析 record_json),
 * 因此 CSV/JSON 都能带上 generated_sql/executed_sql 等明细字段;
 * 同时硬性追加 `LIMIT`,多取一行判断截断,避免无界全表导出。
 */
export function listAuditExportRows(
  filters: QueryAuditFilters,
  limit = exportRowLimit(),
): { rows: AuditExportRow[]; truncated: boolean } {
  ensureAuditTable();
  const { conditions, params } = auditFilterClause(filters);
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const fetched = openDb()
    .prepare(
      `SELECT id, actor, actor_type, entrypoint, source, sql_source, status, question,
              original_question, generated_sql, executed_sql, row_count, duration_ms,
              started_at, finished_at, error, workspace, parent_audit_id
       FROM observatory_query_audits
       ${where}
       ORDER BY started_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(...params, limit + 1) as unknown as AuditExportDbRow[];
  const truncated = fetched.length > limit;
  const visible = truncated ? fetched.slice(0, limit) : fetched;
  return {
    truncated,
    rows: visible.map((row) => ({
      id: row.id,
      actor: row.actor,
      actor_type: row.actor_type,
      entrypoint: row.entrypoint,
      source: row.source,
      sql_source: row.sql_source,
      status: row.status,
      original_question: row.original_question || row.question,
      generated_sql: row.generated_sql ?? "",
      executed_sql: row.executed_sql ?? "",
      row_count: row.row_count,
      duration_ms: row.duration_ms,
      started_at: row.started_at,
      finished_at: row.finished_at ?? "",
      error: row.error ?? "",
      workspace: row.workspace,
      parent_audit_id: row.parent_audit_id ?? "",
    })),
  };
}

/** 审计表由 queryAudit 模块惰性建表;导出可能先于首条写入发生,这里先确保表存在。 */
function ensureAuditTable(): void {
  listQueryAudits({ limit: 0 });
}
