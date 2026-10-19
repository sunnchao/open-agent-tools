import type { Response } from "express";
import {
  contentDisposition,
  CSV_CONTENT_TYPE,
  exportFilename,
  serializeCsv,
  type CsvColumn,
} from "./csv.js";

export type ExportFormat = "csv" | "json";

/** 解析 `?format=`:缺省按 csv;显式给出 csv/json 之外的值一律视为非法。 */
export function parseExportFormat(value: unknown): ExportFormat | null {
  if (value === undefined || value === "") return "csv";
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "csv") return "csv";
  if (normalized === "json") return "json";
  return null;
}

export interface ExportResponse<T> {
  format: ExportFormat;
  /** CSV 列定义;JSON 导出直接返回同字段数组,不使用 columns。 */
  columns: Array<CsvColumn<T>>;
  rows: T[];
  /** 文件名主体(不含时间戳与扩展名),必须是可读的 ASCII 短语。 */
  filenameBase: string;
  /** 命中条数上限被截断时为 true,通过响应头明示。 */
  truncated: boolean;
}

/**
 * 统一的导出响应:
 * - CSV 带 UTF-8 BOM 与 CRLF 行尾,`Content-Type` 固定 `text/csv; charset=utf-8`;
 * - JSON 返回与 CSV 同字段的数组;
 * - 两者都带 attachment 文件名;被截断时统一附加 `x-export-truncated: true`。
 */
export function sendExport<T>(res: Response, payload: ExportResponse<T>): void {
  const { format, columns, rows, filenameBase, truncated } = payload;
  const filename = exportFilename(filenameBase, format === "json" ? "json" : "csv");
  res.set("Content-Disposition", contentDisposition(filename));
  if (truncated) res.set("x-export-truncated", "true");
  if (format === "json") {
    res.set("Content-Type", "application/json; charset=utf-8");
    res.send(JSON.stringify(rows));
    return;
  }
  res.set("Content-Type", CSV_CONTENT_TYPE);
  res.send(serializeCsv(columns, rows));
}
