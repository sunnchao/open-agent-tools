import { validateQuerySql } from "../function-tools/sqlQueryBuiltin.js";
import { BLOCKED_FOREIGN_TABLES, DTMS_TABLE_NAMES } from "./dtmsCatalog.js";

const COMMENT = /--|\/\*|\*\/|#/;
const FROM_JOIN = /\b(?:from|join)\s+`?([a-zA-Z_][a-zA-Z0-9_]*)`?/gi;
const IDENT = /`([a-zA-Z_][a-zA-Z0-9_]*)`|\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g;

const SENSITIVE_COLUMN =
  /(bank_account|bank_no|account_no|mobile|phone|id_card|idcard|password|secret|token)/i;

export class SqlGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlGuardError";
  }
}

function stripStringLiterals(sql: string): string {
  return sql.replace(/'(?:\\'|[^'])*'/g, "''").replace(/"(?:\\"|[^"])*"/g, '""');
}

export function extractTableNames(sql: string): string[] {
  const body = stripStringLiterals(sql);
  const names = new Set<string>();
  for (const match of body.matchAll(FROM_JOIN)) {
    const name = match[1];
    if (name) names.add(name.toLowerCase());
  }
  return [...names];
}

export function containsForeignSystem(sql: string): string | null {
  const body = stripStringLiterals(sql).toLowerCase();
  for (const table of BLOCKED_FOREIGN_TABLES) {
    const re = new RegExp(`(?:from|join)\\s+\`?${table}\\b|\`${table}\``, "i");
    if (re.test(body)) return table;
  }
  return null;
}

/** DTMS 问数护栏：只读 + 无注释 + 表白名单 + 拒绝 NEW-API 表。 */
export function validateDtmsQuerySql(sql: string): void {
  validateQuerySql(sql);
  const body = stripStringLiterals(sql);
  if (COMMENT.test(body)) {
    throw new SqlGuardError("SQL 包含注释符");
  }
  const foreign = containsForeignSystem(sql);
  if (foreign) {
    throw new SqlGuardError(`禁止查询非 DTMS 表：${foreign}`);
  }
  const tables = extractTableNames(sql);
  if (tables.length === 0) {
    throw new SqlGuardError("SQL 未引用任何 DTMS 业务表");
  }
  const allowed = new Set(DTMS_TABLE_NAMES.map((n) => n.toLowerCase()));
  for (const table of tables) {
    if (!allowed.has(table)) {
      throw new SqlGuardError(`表不在 DTMS 白名单：${table}`);
    }
  }
  for (const match of body.matchAll(IDENT)) {
    const ident = (match[1] ?? match[2] ?? "").toLowerCase();
    if (SENSITIVE_COLUMN.test(ident)) {
      throw new SqlGuardError(`禁止查询敏感字段：${ident}`);
    }
  }
}

const MASK_KEY = /(bank|account|mobile|phone|id_card|idcard|password|secret|token)/i;

/** 结果行脱敏：敏感列名打码，不向前端返回原文。 */
export function maskSensitiveRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      next[key] = MASK_KEY.test(key) ? "***" : value;
    }
    return next;
  });
}
