import { createRagClient } from "@open-agent-tools/studio-client";
import { ragRequest } from "../lib/http";
import type { UploadDocumentSettings } from "@open-agent-tools/api-contracts/rag";
export type {
  ChunkStrategy,
  DocumentSource,
  DocumentStats,
  ChunkInfo,
  RetrievalChannel,
  RetrievalChannelHit,
  GraphChannelHit,
  GraphQueryAugmentation,
  QueryChunkHit,
  RetrievalPayload,
  QueryResult,
  QueryFeedbackRating,
  QueryAttribution,
  QualityReport,
  AnalyticsOverview,
  QueryKnowledgeInput,
  UploadDocumentSettings,
} from "@open-agent-tools/api-contracts/rag";
const client = createRagClient(ragRequest);
export const {
  listDocuments,
  listChunks,
  deleteDocument,
  updateDocument,
  recallOptions,
  queryKnowledge,
  getAnalyticsOverview,
  getQualityReport,
  submitQueryFeedback,
} = client;
export interface UploadDocInput {
  name: string;
  mimeType?: string;
  data: Blob | Uint8Array | string;
}
export function uploadDocuments(
  files: UploadDocInput[],
  settings: UploadDocumentSettings,
): Promise<{ files: number; chunks: number }> {
  const form = new FormData();
  files.forEach((file) => {
    const blob =
      typeof file.data === "string"
        ? new Blob([file.data])
        : file.data instanceof Uint8Array
          ? new Blob([file.data as unknown as BlobPart])
          : file.data;
    form.append("files", blob, file.name);
  });
  return client.uploadDocuments(form, settings);
}
