import { studioFetch } from "../../lib/client.js";
import { filenameFromDisposition } from "@open-agent-tools/studio-client";
export {
  auditExportPath,
  usageExportPath,
  filenameFromDisposition,
} from "@open-agent-tools/studio-client";
export type { ExportFormat, UsageExportFilters } from "@open-agent-tools/studio-client";

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
