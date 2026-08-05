export interface DocumentStats {
  sources: Array<{ source: string; chunks: number }>;
  chunks: number;
  embeddingsEnabled: boolean;
  llmAvailable: boolean;
  chunkSize: number;
  chunkOverlap: number;
  separators: string[];
}

export interface ChunkInfo {
  id: string;
  source: string;
  chunkIndex: number;
  content: string;
  length: number;
  hasEmbedding: boolean;
}

export interface QueryResult {
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

export function deleteDocument(source: string): Promise<{ ok: true }> {
  return request(`/documents/${encodeURIComponent(source)}`, { method: "DELETE" });
}

export function uploadDocuments(
  files: File[],
  settings: { chunkSize: number; chunkOverlap: number; separators: string[] },
): Promise<{ files: number; chunks: number }> {
  const form = new FormData();
  files.forEach((file) => form.append("files", file));
  form.append("chunkSize", String(settings.chunkSize));
  form.append("chunkOverlap", String(settings.chunkOverlap));
  form.append("separators", JSON.stringify(settings.separators));
  return request("/documents", { method: "POST", body: form });
}

export function queryKnowledge(input: {
  query: string;
  topK: number;
  generate: boolean;
}): Promise<QueryResult> {
  return request("/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}
