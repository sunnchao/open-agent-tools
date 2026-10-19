import { studioFetch } from "../../lib/client.js";
import type { QueryAuditFilters } from "./api.js";

export type ExportFormat = "csv" | "json";

/** 审计导出复用的筛选键(与列表接口一致,但导出不带分页参数)。 */
const AUDIT_EXPORT_KEYS: ReadonlyArray<keyof QueryAuditFilters> = [
  "sourceId",
  "actor",
  "entrypoint",
  "source",
  "sqlSource",
  "status",
  "parentAuditId",
  "from",
  "to",
  "search",
];

/** 问数审计导出 URL:带上当前筛选条件,省略 limit/offset。 */
export function auditExportPath(filters: QueryAuditFilters, format: ExportFormat): string {
  const params = new URLSearchParams({ format });
  for (const key of AUDIT_EXPORT_KEYS) {
    const value = filters[key];
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  return `/api/observatory/audits/export?${params.toString()}`;
}

export interface UsageExportFilters {
  days?: number;
  all?: boolean;
  kind?: "chat" | "tool";
  from?: string;
  to?: string;
}

/** 用量导出 URL:`days`/`all`/`kind` 与服务端 `/api/admin/usage` 口径一致。 */
export function usageExportPath(filters: UsageExportFilters, format: ExportFormat): string {
  const params = new URLSearchParams({ format });
  if (filters.days !== undefined) params.set("days", String(filters.days));
  if (filters.all) params.set("workspaceId", "*");
  if (filters.kind) params.set("kind", filters.kind);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  return `/api/admin/usage/export?${params.toString()}`;
}

/**
 * 解析 `Content-Disposition` 里的下载文件名:
 * 优先 RFC5987 的 `filename*=UTF-8''…`,其次普通 `filename=`;解析失败回落到默认名。
 */
export function filenameFromDisposition(
  header: string | null | undefined,
  fallback: string,
): string {
  if (!header) return fallback;
  const extended = /filename\*=\s*UTF-8''([^;]+)/i.exec(header);
  if (extended?.[1]) {
    try {
      const decoded = decodeURIComponent(extended[1].trim());
      if (decoded) return decoded;
    } catch {
      // 解码失败时继续尝试普通 filename。
    }
  }
  const basic = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(header);
  const value = (basic?.[1] ?? basic?.[2])?.trim();
  return value ? value : fallback;
}

export interface ExportDownload {
  blob: Blob;
  filename: string;
}

/**
 * 通过 `studioFetch`(自动携带 Authorization 与 workspace 头)取导出内容并触发下载。
 * 不使用 `<a href>` 直链:直链会丢掉鉴权头,受保护接口会 401。
 */
export async function downloadExport(
  path: string,
  fallbackFilename: string,
  save: (download: ExportDownload) => void = triggerBlobDownload,
): Promise<ExportDownload> {
  const response = await studioFetch(path);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `导出失败(HTTP ${response.status})`);
  }
  const blob = await response.blob();
  const download: ExportDownload = {
    blob,
    filename: filenameFromDisposition(
      response.headers.get("content-disposition"),
      fallbackFilename,
    ),
  };
  save(download);
  return download;
}

/** 浏览器下载落盘。非浏览器环境(如单测)可通过 `downloadExport` 的 save 参数替换。 */
export function triggerBlobDownload({ blob, filename }: ExportDownload): void {
  const url = globalThis.URL.createObjectURL(blob);
  const anchor = globalThis.document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  globalThis.document.body.append(anchor);
  anchor.click();
  anchor.remove();
  globalThis.URL.revokeObjectURL(url);
}
