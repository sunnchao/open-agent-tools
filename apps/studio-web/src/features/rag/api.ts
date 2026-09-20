export interface DocumentSource {
  source: string;
  title: string;
  tags: string[];
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
  createdAt: string;
  updatedAt: string;
}

export interface DocumentStats {
  sources: DocumentSource[];
  chunks: number;
  embeddingsEnabled: boolean;
  llmAvailable: boolean;
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

export interface QueryResult {
  queryId: string;
  query: string;
  chunks: Array<{
    id: string;
    source: string;
    chunkIndex: number;
    content: string;
    score: number;
  }>;
  answer: string | null;
  generate: boolean;
  llmAvailable: boolean;
}

export type QueryFeedbackRating = "positive" | "negative";

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
    createdAt: string;
  }>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/rag-api${path}`, init);
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
  patch: { title?: string; tags?: string[] },
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

export function getAnalyticsOverview(days = 14): Promise<AnalyticsOverview> {
  return request(`/analytics/overview?days=${days}`);
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
