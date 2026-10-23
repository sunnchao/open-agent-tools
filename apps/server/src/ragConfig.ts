export interface RagServerConfig {
  baseUrl: string;
  token: string;
}

/** Resolve the server-only RAG connection settings from the environment. */
export function ragConfig(): RagServerConfig {
  return {
    baseUrl: (process.env.RAG_API_URL ?? "http://localhost:4001/api").replace(/\/$/, ""),
    token: process.env.RAG_ADMIN_TOKEN?.trim() ?? "",
  };
}
