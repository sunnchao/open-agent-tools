import { agentFetch, parseError } from "../lib/http";
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
