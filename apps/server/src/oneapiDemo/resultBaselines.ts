import { openDb } from "../db.js";
import { numericMediansOf, type QueryResultBaseline } from "./resultChecks.js";

/**
 * 结果校验基线:按「数据源 + 问题指纹」保存上一次成功查询的观测值。
 *
 * 只存聚合后的行数与各列中位数,不落任何明细数据,避免把业务数据复制到审计库。
 * 表由本模块按需创建,不改动 `db.ts` 中既有建表语句,便于独立演进。
 */

function ensureTable(): void {
  openDb().exec(`
    CREATE TABLE IF NOT EXISTS query_result_baselines (
      source_id TEXT NOT NULL,
      question_key TEXT NOT NULL,
      row_count INTEGER NOT NULL,
      numeric_medians_json TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      PRIMARY KEY (source_id, question_key)
    );
  `);
}

/**
 * 问题指纹:同一问法(去空白、转小写)视为同一条基线。
 * 用简单归一化而非哈希,便于排障时直接读表;长度上限防超长问题撑爆主键。
 */
export function questionKeyOf(question: string): string {
  return question.replace(/\s+/g, "").toLowerCase().slice(0, 500);
}

export function loadResultBaseline(sourceId: string, question: string): QueryResultBaseline | null {
  ensureTable();
  const row = openDb()
    .prepare(
      `SELECT row_count, numeric_medians_json, captured_at
         FROM query_result_baselines WHERE source_id = ? AND question_key = ?`,
    )
    .get(sourceId, questionKeyOf(question)) as
    { row_count: number; numeric_medians_json: string; captured_at: string } | undefined;
  if (!row) return null;
  let numericMedians: Record<string, number> = {};
  try {
    const parsed = JSON.parse(row.numeric_medians_json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "number" && Number.isFinite(value)) numericMedians[key] = value;
      }
    }
  } catch {
    // 基线损坏时按「无基线」处理,不影响查询主链路。
    numericMedians = {};
  }
  return {
    rowCount: row.row_count,
    numericMedians,
    capturedAt: row.captured_at,
  };
}

export function recordResultBaseline(
  sourceId: string,
  question: string,
  rows: Record<string, unknown>[],
): void {
  ensureTable();
  openDb()
    .prepare(
      `INSERT INTO query_result_baselines
         (source_id, question_key, row_count, numeric_medians_json, captured_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(source_id, question_key) DO UPDATE SET
         row_count = excluded.row_count,
         numeric_medians_json = excluded.numeric_medians_json,
         captured_at = excluded.captured_at`,
    )
    .run(
      sourceId,
      questionKeyOf(question),
      rows.length,
      JSON.stringify(numericMediansOf(rows)),
      new Date().toISOString(),
    );
}
