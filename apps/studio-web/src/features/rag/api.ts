import { createRagClient } from "@open-agent-tools/studio-client";
import { ragRequest } from "../../lib/client.js";
import type { UploadDocumentSettings } from "@open-agent-tools/api-contracts/rag";
export type {
  DocumentSource,
  OcrStatus,
  DocumentStats,
  ChunkStrategy,
  ChunkInfo,
  RetrievalChannel,
  RetrievalChannelHit,
  GraphChannelHit,
  QueryChunkHit,
  GraphQueryAugmentation,
  RetrievalPayload,
  QueryResult,
  QueryDetailTraceHit,
  QueryDetailTraceChunk,
  QueryDetail,
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
  getQueryDetail,
  getAnalyticsOverview,
  getQualityReport,
  submitQueryFeedback,
} = client;
export function uploadDocuments(
  files: File[],
  settings: UploadDocumentSettings,
): Promise<{ files: number; chunks: number }> {
  const form = new FormData();
  files.forEach((file) => form.append("files", file));
  return client.uploadDocuments(form, settings);
}
