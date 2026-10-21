import { agentFetch, parseError } from "../lib/http";
import type { QueryAuditFilters } from "./observatory";

export type ExportFormat = "csv" | "json";
const AUDIT_EXPORT_KEYS = [
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
] as const;

export function auditExportPath(filters: QueryAuditFilters, format: ExportFormat): string {
  const params = new URLSearchParams({ format });
  for (const key of AUDIT_EXPORT_KEYS) {
    const value = (filters as Record<string, unknown>)[key];
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
export function usageExportPath(filters: UsageExportFilters, format: ExportFormat): string {
  const params = new URLSearchParams({ format });
  if (filters.days !== undefined) params.set("days", String(filters.days));
  if (filters.all) params.set("workspaceId", "*");
  if (filters.kind) params.set("kind", filters.kind);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  return `/api/admin/usage/export?${params.toString()}`;
}
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
      /* fallback */
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
/** RN 取导出内容：返回 Blob + 文件名，由宿主（Share/FileSystem）落盘/分享。 */
export async function downloadExport(
  path: string,
  fallbackFilename: string,
): Promise<ExportDownload> {
  const response = await agentFetch(path);
  if (!response.ok) throw new Error(await parseError(response));
  const blob = await response.blob();
  return {
    blob,
    filename: filenameFromDisposition(
      response.headers.get("content-disposition"),
      fallbackFilename,
    ),
  };
}
