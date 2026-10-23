import type {
  DocumentSource,
  DocumentStats,
  ChunkInfo,
  QueryKnowledgeInput,
  QueryResult,
  QueryDetail,
  QueryFeedbackRating,
  QualityReport,
  AnalyticsOverview,
  UploadDocumentSettings,
} from "@open-agent-tools/api-contracts/rag";
export function createRagClient(request: <T>(path: string, init?: RequestInit) => Promise<T>) {
  function listDocuments(): Promise<DocumentStats> {
    return request("/documents");
  }
  function listChunks(source: string): Promise<{ source: string; chunks: ChunkInfo[] }> {
    return request(`/documents/${encodeURIComponent(source)}/chunks`);
  }
  function deleteDocument(
    source: string,
  ): Promise<{ ok: true; source: string; graph?: { entities: number; relations: number } }> {
    return request(`/documents/${encodeURIComponent(source)}`, { method: "DELETE" });
  }
  function updateDocument(
    source: string,
    patch: { title?: string; tags?: string[]; allowedGroups?: string[] },
  ): Promise<{ document: DocumentSource }> {
    return request(`/documents/${encodeURIComponent(source)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
  }
  function uploadDocuments(
    form: FormData,
    settings: UploadDocumentSettings,
  ): Promise<{ files: number; chunks: number }> {
    form.append("chunkSize", String(settings.chunkSize));
    form.append("chunkOverlap", String(settings.chunkOverlap));
    form.append("chunkStrategy", settings.chunkStrategy);
    form.append("separators", JSON.stringify(settings.separators));
    form.append("semanticThreshold", String(settings.semanticThreshold));
    return request("/documents", { method: "POST", body: form });
  }
  function recallOptions(graphRecall: boolean): { graph?: false; keyword?: false } {
    return graphRecall ? {} : { graph: false, keyword: false };
  }
  function queryKnowledge(input: QueryKnowledgeInput): Promise<QueryResult> {
    return request("/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }
  function getQueryDetail(queryId: string): Promise<{ detail: QueryDetail }> {
    return request(`/query/${encodeURIComponent(queryId)}`);
  }
  function getAnalyticsOverview(days = 14): Promise<AnalyticsOverview> {
    return request(`/analytics/overview?days=${days}`);
  }
  function getQualityReport(days: 7 | 30): Promise<QualityReport> {
    return request(`/analytics/quality-report?days=${days}`);
  }
  function submitQueryFeedback(
    queryId: string,
    rating: QueryFeedbackRating,
    comment?: string,
  ): Promise<{
    feedback: { queryId: string; rating: QueryFeedbackRating; comment: string | null };
  }> {
    return request(`/query/${encodeURIComponent(queryId)}/feedback`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rating, ...(comment ? { comment } : {}) }),
    });
  }
  return {
    listDocuments,
    listChunks,
    deleteDocument,
    updateDocument,
    uploadDocuments,
    recallOptions,
    queryKnowledge,
    getQueryDetail,
    getAnalyticsOverview,
    getQualityReport,
    submitQueryFeedback,
  };
}
