import { studioFetch } from "../../lib/client.js";
import type { MessageUsage } from "../../types.js";

export interface DocumentSource {
  source: string;
  title: string;
  tags: string[];
  /** 可查看该文档的分组；空数组表示公开。 */
  allowedGroups: string[];
  mimeType: string;
  byteSize: number;
  contentHash: string;
  chunks: number;
  version: number;
  chunkStrategy: ChunkStrategy;
  chunkSize: number;
  chunkOverlap: number;
  separators: string[];
  semanticThreshold: number | null;
  /** 是否经 OCR 兜底生成；旧服务端缺字段时前端按 false 处理。 */
  ocrApplied: boolean;
  /** none | text_layer | ocr | ocr_needed | ocr_failed */
  ocrStatus: OcrStatus;
  createdAt: string;
  updatedAt: string;
}

export type OcrStatus = "none" | "text_layer" | "ocr" | "ocr_needed" | "ocr_failed";

export interface DocumentStats {
  sources: DocumentSource[];
  chunks: number;
  embeddingsEnabled: boolean;
  llmAvailable: boolean;
  ocrEnabled: boolean;
  ocrMinCharsPerPage: number;
  ocrMaxPagesSync: number;
  chunkSize: number;
  chunkOverlap: number;
  chunkStrategy: ChunkStrategy;
  separators: string[];
  semanticThreshold: number;
}

export type ChunkStrategy = "fixed" | "semantic";

export interface ChunkInfo {
  id: string;
  source: string;
  chunkIndex: number;
  content: string;
  length: number;
  hasEmbedding: boolean;
}

export interface RetrievalChannelHit {
  id: string;
  source: string;
  chunkIndex: number;
  content: string;
  score: number;
  rank: number;
}

export interface QueryChunkHit extends RetrievalChannelHit {
  debug?: {
    vectorScore: number | null;
    vectorRank: number | null;
    keywordScore: number | null;
    keywordRank: number | null;
    rrfScore: number;
    channels: Array<"vector" | "keyword">;
  };
}

export interface RetrievalPayload {
  store: string;
  embeddingsEnabled: boolean;
  candidates: number;
  rrfK: number;
  timingsMs: { vectorMs: number | null; keywordMs: number; fusionMs: number };
  vectorHits: RetrievalChannelHit[];
  keywordHits: RetrievalChannelHit[];
}

export interface QueryResult {
  usage?: MessageUsage;
  queryId: string;
  query: string;
  chunks: QueryChunkHit[];
  /** 双路明细：与 chunks[].debug 同源，老服务端缺失时前端降级只展示 RRF。 */
  retrieval?: RetrievalPayload;
  answer: string | null;
  generate: boolean;
  llmAvailable: boolean;
}

export type QueryDetailTraceHit = RetrievalChannelHit;

export interface QueryDetailTraceChunk extends RetrievalChannelHit {
  vectorScore: number | null;
  vectorRank: number | null;
  keywordScore: number | null;
  keywordRank: number | null;
  rrfScore: number;
  channels: Array<"vector" | "keyword">;
}

export interface QueryDetail {
  id: string;
  query: string;
  sources: string[];
  sourceCount: number;
  topK: number;
  generate: boolean;
  crag: boolean;
  hitCount: number;
  answerGenerated: boolean;
  answer: string | null;
  attribution: QueryAttribution;
  assessment: string | null;
  actions: string[];
  latencyMs: number;
  error: string | null;
  createdAt: string;
  feedback: QueryFeedbackRating | null;
  feedbackComment: string | null;
  trace: {
    store: string;
    embeddingsEnabled: boolean;
    candidates: number;
    rrfK: number;
    timingsMs: { vectorMs: number | null; keywordMs: number; fusionMs: number };
    visibleSources?: string[];
    viewerGroups?: string[];
    vectorHits: QueryDetailTraceHit[];
    keywordHits: QueryDetailTraceHit[];
    fused: QueryDetailTraceChunk[];
    formatted?: string | null;
    answer?: string | null;
    truncated: boolean;
  } | null;
}

export type QueryFeedbackRating = "positive" | "negative";
export type QueryAttribution =
  | "no_documents"
  | "retrieval_miss"
  | "low_relevance"
  | "model_refusal"
  | "error"
  | "answered"
  | "unknown";

export interface QualityReport {
  periodDays: 7 | 30;
  generatedAt: string;
  totals: {
    queries: number;
    answered: number;
    hits: number;
    noAnswer: number;
    hitRate: number;
    noAnswerRate: number;
  };
  attribution: Record<QueryAttribution, number>;
  topUnanswered: Array<{
    query: string;
    count: number;
    attribution: Exclude<QueryAttribution, "answered" | "unknown">;
  }>;
  trend: Array<{
    date: string;
    queries: number;
    answered: number;
    noAnswer: number;
    hitRate: number;
    noAnswerRate: number;
  }>;
}

export interface AnalyticsOverview {
  periodDays: number;
  totals: {
    queries: number;
    failed: number;
    noHits: number;
    noHitRate: number;
    averageLatencyMs: number;
    positiveFeedback: number;
    negativeFeedback: number;
    helpfulRate: number | null;
  };
  daily: Array<{ date: string; queries: number; noHits: number; failed: number }>;
  topSources: Array<{ source: string; hits: number; queries: number }>;
  recent: Array<{
    id: string;
    query: string;
    hitCount: number;
    latencyMs: number;
    error: string | null;
    feedback: QueryFeedbackRating | null;
    attribution: QueryAttribution;
    createdAt: string;
  }>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // 经 Agent Server 管理 BFF 转发；浏览器永远不持有 RAG_ADMIN_TOKEN。
  const response = await studioFetch(`/api/admin/rag${path}`, init);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `RAG request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

export function listDocuments(): Promise<DocumentStats> {
  return request("/documents");
}

export function listChunks(source: string): Promise<{ source: string; chunks: ChunkInfo[] }> {
  return request(`/documents/${encodeURIComponent(source)}/chunks`);
}

/** 删除文档：分块与派生的图谱实体关系一并清理，graph 字段回传图谱侧的回收量。 */
export function deleteDocument(
  source: string,
): Promise<{ ok: true; source: string; graph?: { entities: number; relations: number } }> {
  return request(`/documents/${encodeURIComponent(source)}`, { method: "DELETE" });
}

export function updateDocument(
  source: string,
  patch: { title?: string; tags?: string[]; allowedGroups?: string[] },
): Promise<{ document: DocumentSource }> {
  return request(`/documents/${encodeURIComponent(source)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export function uploadDocuments(
  files: File[],
  settings: {
    chunkSize: number;
    chunkOverlap: number;
    chunkStrategy: ChunkStrategy;
    separators: string[];
    semanticThreshold: number;
  },
): Promise<{ files: number; chunks: number }> {
  const form = new FormData();
  files.forEach((file) => form.append("files", file));
  form.append("chunkSize", String(settings.chunkSize));
  form.append("chunkOverlap", String(settings.chunkOverlap));
  form.append("chunkStrategy", settings.chunkStrategy);
  form.append("separators", JSON.stringify(settings.separators));
  form.append("semanticThreshold", String(settings.semanticThreshold));
  return request("/documents", { method: "POST", body: form });
}

export function queryKnowledge(input: {
  query: string;
  topK: number;
  generate: boolean;
  sources?: string[];
}): Promise<QueryResult> {
  return request("/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function getQueryDetail(queryId: string): Promise<{ detail: QueryDetail }> {
  return request(`/query/${encodeURIComponent(queryId)}`);
}

export function getAnalyticsOverview(days = 14): Promise<AnalyticsOverview> {
  return request(`/analytics/overview?days=${days}`);
}

export function getQualityReport(days: 7 | 30): Promise<QualityReport> {
  return request(`/analytics/quality-report?days=${days}`);
}

export function submitQueryFeedback(
  queryId: string,
  rating: QueryFeedbackRating,
  comment?: string,
): Promise<{ feedback: { queryId: string; rating: QueryFeedbackRating; comment: string | null } }> {
  return request(`/query/${encodeURIComponent(queryId)}/feedback`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rating, ...(comment ? { comment } : {}) }),
  });
}
