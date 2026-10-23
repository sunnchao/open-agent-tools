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

export type AuditExportFilters = Partial<Record<(typeof AUDIT_EXPORT_KEYS)[number], string>> & {
  limit?: number;
  offset?: number;
};

/** 列表与导出共用筛选项，导出不携带分页参数。 */
export function auditExportPath(filters: AuditExportFilters, format: ExportFormat): string {
  const params = new URLSearchParams({ format });
  for (const key of AUDIT_EXPORT_KEYS) {
    const value = filters[key];
    if (value !== undefined && value !== "") params.set(key, value);
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

/** 优先 RFC5987 文件名，畸形编码回退到普通文件名或默认值。 */
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
      /* 尝试普通 filename。 */
    }
  }
  const basic = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(header);
  return (basic?.[1] ?? basic?.[2])?.trim() || fallback;
}
