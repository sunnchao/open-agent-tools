import { openDb } from "../db.js";
import type { CsvColumn } from "../export/csv.js";

/** 单次导出最多返回的明细行数:足够覆盖例行内审,又不至于把内存打爆。 */
export const DEFAULT_EXPORT_ROW_LIMIT = 50_000;

/**
 * 导出上限。默认 50000;可通过 `EXPORT_MAX_ROWS` 调低(只允许收紧,不能放宽),
 * 便于小规格部署按内存预算限制,也让测试能在不改变硬上限语义的前提下验证截断。
 */
export function exportRowLimit(): number {
  const raw = Number(process.env.EXPORT_MAX_ROWS);
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_EXPORT_ROW_LIMIT;
  return Math.max(1, Math.min(DEFAULT_EXPORT_ROW_LIMIT, Math.floor(raw)));
}

export type UsageExportKind = "chat" | "tool";

export interface UsageExportRow {
  id: string;
  created_at: string;
  kind: string;
  source: string;
  requests: number;
  workspace_id: string;
  model: string;
  tool_name: string;
  status: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  duration_ms: number;
  /** usage_events 里的会话标识,作为事件的引用(ref)列。 */
  ref_id: string;
}

export interface UsageExportOptions {
  from?: number;
  to?: number;
  kind?: UsageExportKind;
  /** 省略表示跨全部 workspace(与查询参数 `workspaceId=*` 对应)。 */
  workspaceId?: string;
  limit?: number;
}

interface UsageExportDbRow {
  id: string;
  created_at: number;
  kind: string;
  source: string;
  requests: number;
  workspace_id: string | null;
  model: string | null;
  tool_name: string | null;
  status: string;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
  session_id: string | null;
}

/** 导出列顺序与需求一致:id/created_at/kind/workspace_id/model/tool_name/... */
export const USAGE_EXPORT_COLUMNS: Array<CsvColumn<UsageExportRow>> = [
  { header: "id", value: (row) => row.id },
  { header: "created_at", value: (row) => row.created_at },
  { header: "kind", value: (row) => row.kind },
  { header: "workspace_id", value: (row) => row.workspace_id },
  { header: "model", value: (row) => row.model },
  { header: "tool_name", value: (row) => row.tool_name },
  { header: "status", value: (row) => row.status },
  { header: "input_tokens", value: (row) => row.input_tokens },
  { header: "output_tokens", value: (row) => row.output_tokens },
  { header: "total_tokens", value: (row) => row.total_tokens },
  { header: "duration_ms", value: (row) => row.duration_ms },
  { header: "ref_id", value: (row) => row.ref_id },
  { header: "source", value: (row) => row.source },
  { header: "requests", value: (row) => row.requests },
];

/**
 * 按时间窗/类型/空间读取用量明细。
 *
 * 直接读 `usage_events` 表并硬性追加 `LIMIT`,不做无界全表导出:
 * 多取一行用于判断是否被截断,再按上限切片返回。
 */
export function listUsageExportRows(options: UsageExportOptions): {
  rows: UsageExportRow[];
  truncated: boolean;
} {
  const limit = options.limit ?? exportRowLimit();
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (options.from !== undefined) {
    conditions.push("created_at >= ?");
    params.push(options.from);
  }
  if (options.to !== undefined) {
    conditions.push("created_at <= ?");
    params.push(options.to);
  }
  if (options.kind) {
    conditions.push("kind = ?");
    params.push(options.kind);
  }
  if (options.workspaceId) {
    conditions.push("workspace_id = ?");
    params.push(options.workspaceId);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const fetched = openDb()
    .prepare(
      `SELECT id, created_at, kind, source, requests, workspace_id, model, tool_name, status,
              input_tokens, output_tokens, duration_ms, session_id
       FROM usage_events
       ${where}
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(...params, limit + 1) as unknown as UsageExportDbRow[];
  const truncated = fetched.length > limit;
  const visible = truncated ? fetched.slice(0, limit) : fetched;
  return {
    truncated,
    rows: visible.map((row) => ({
      id: row.id,
      created_at: new Date(row.created_at).toISOString(),
      kind: row.kind,
      source: row.source,
      requests: row.requests,
      workspace_id: row.workspace_id ?? "",
      model: row.model ?? "",
      tool_name: row.tool_name ?? "",
      status: row.status,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      total_tokens: row.input_tokens + row.output_tokens,
      duration_ms: row.duration_ms,
      ref_id: row.session_id ?? "",
    })),
  };
}
