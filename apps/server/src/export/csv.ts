/**
 * 审计导出的 CSV 序列化与文件名工具。
 *
 * 导出面向上级检查、等保与内审:Excel/WPS 打开中文不能乱码,字段里出现逗号、
 * 引号或换行也不能串列。因此遵循 RFC4180:含特殊字符的字段整体加双引号,内部
 * 双引号转义为 `""`,行尾统一 CRLF,并在文件开头写入 UTF-8 BOM。
 */

/** CSV 响应类型:显式声明 charset,避免被按 latin-1 解析导致中文乱码。 */
export const CSV_CONTENT_TYPE = "text/csv; charset=utf-8";

export type CsvValue = string | number | boolean | null | undefined;

export interface CsvColumn<T> {
  /** 表头文本(导出报表的列名)。 */
  header: string;
  /** 从记录中取出该列的值;null/undefined 输出空串。 */
  value: (record: T) => CsvValue;
}

/** RFC4180 单元转义:含逗号/引号/换行/回车时整体加引号,内部 `"` 翻倍为 `""`。 */
export function escapeCsvValue(value: CsvValue): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * 序列化整张表。默认带 UTF-8 BOM 且使用 CRLF 行尾,便于 Excel 直接打开。
 * 末尾统一补一个行尾,避免最后一行缺少换行符被部分工具截断。
 */
export function serializeCsv<T>(
  columns: Array<CsvColumn<T>>,
  rows: T[],
  options: { bom?: boolean } = {},
): string {
  const lines = [
    columns.map((column) => escapeCsvValue(column.header)).join(","),
    ...rows.map((row) => columns.map((column) => escapeCsvValue(column.value(row))).join(",")),
  ];
  const body = `${lines.join("\r\n")}\r\n`;
  return options.bom === false ? body : `\ufeff${body}`;
}

/** 文件名时间戳(UTC,纯数字),不受部署时区影响且始终是 ASCII。 */
export function timestampSegment(date: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

/**
 * 文件名片段净化:只保留 ASCII 字母数字与 `._-`,其余一律替换为 `-`。
 * 这样从根源上消除 CR/LF/引号等响应头注入字符,结果为空时回落到 `export`。
 */
export function sanitizeFilenameSegment(segment: string): string {
  const cleaned = segment
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/[-.]+$/, "");
  return cleaned || "export";
}

/** 生成下载文件名:`<base>-<UTC 时间戳>.<ext>`,base/ext 均经过白名单净化。 */
export function exportFilename(base: string, extension: string, date: Date = new Date()): string {
  const ext = sanitizeFilenameSegment(extension).replace(/[^A-Za-z0-9]/g, "") || "csv";
  return `${sanitizeFilenameSegment(base)}-${timestampSegment(date)}.${ext}`;
}

/** 兜底构造 `Content-Disposition`:强制 attachment 且文件名只保留安全字符。 */
export function contentDisposition(filename: string): string {
  return `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`;
}
