import type { QueryAuditFilters } from "./queryAudit.js";

/** 与 listQueryAudits 保持一致的筛选 SQL,确保导出结果与列表页是同一批数据。 */
export function auditFilterClause(filters: QueryAuditFilters): {
  conditions: string[];
  params: Array<string | number>;
} {
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (filters.sourceId) {
    conditions.push("source_id = ?");
    params.push(filters.sourceId);
  }
  if (filters.status) {
    conditions.push("status = ?");
    params.push(filters.status);
  }
  if (filters.actor) {
    conditions.push("actor = ?");
    params.push(filters.actor);
  }
  if (filters.entrypoint) {
    conditions.push("entrypoint = ?");
    params.push(filters.entrypoint);
  }
  if (filters.source) {
    conditions.push("source = ?");
    params.push(filters.source);
  }
  if (filters.sqlSource) {
    conditions.push("sql_source = ?");
    params.push(filters.sqlSource);
  }
  if (filters.parentAuditId) {
    conditions.push("parent_audit_id = ?");
    params.push(filters.parentAuditId);
  }
  if (filters.workspace) {
    conditions.push("workspace = ?");
    params.push(filters.workspace);
  }
  if (filters.from) {
    conditions.push("started_at >= ?");
    params.push(filters.from);
  }
  if (filters.to) {
    conditions.push("started_at <= ?");
    params.push(filters.to);
  }
  if (filters.search) {
    conditions.push(
      `(instr(lower(question), lower(?)) > 0
        OR instr(lower(original_question), lower(?)) > 0
        OR instr(lower(COALESCE(generated_sql, '')), lower(?)) > 0
        OR instr(lower(COALESCE(executed_sql, '')), lower(?)) > 0
        OR id = ?)`,
    );
    params.push(filters.search, filters.search, filters.search, filters.search, filters.search);
  }
  return { conditions, params };
}
