import { type HttpFetchLike } from "./types.js";
import { ragConfig } from "../rag/config.js";

export interface RagUploadInput {
  /** rag-server 的文档来源名,即上传文件名;同一外部 id 必须稳定复用同名以幂等覆盖。 */
  source: string;
  title: string;
  content: string;
  mimeType: string;
}

/** 上传器抽象:同步引擎只依赖这个接口,测试可注入假实现。 */
export interface ConnectorDocumentUploader {
  upload(input: RagUploadInput, deps: { fetch?: HttpFetchLike }): Promise<void>;
}

/**
 * 站内直传:走 rag-server 的 multipart `/api/documents` 通路(与前端上传、
 * ragAdmin BFF 完全一致),不重新发明传输层。幂等由 rag-server 按 source 覆盖保证。
 */
export const ragDocumentUploader: ConnectorDocumentUploader = {
  async upload(input, deps) {
    const { baseUrl, token } = ragConfig();
    const fetchImpl = deps.fetch ?? (typeof fetch === "function" ? fetch : undefined);
    if (!fetchImpl) throw new Error("no fetch implementation available");
    const form = new FormData();
    form.append("files", new Blob([input.content], { type: input.mimeType }), input.source);
    form.append("chunkStrategy", "fixed");
    const response = await fetchImpl(`${baseUrl}/documents`, {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: form,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `RAG upload failed (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      );
    }
  },
};
