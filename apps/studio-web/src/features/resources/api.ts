import { studioFetch } from "../../lib/client.js";
export interface McpToolResource {
  serviceSlug: string;
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServiceResource {
  serviceSlug: string;
  serviceStatus: string;
  versionStatus: string;
  tools: McpToolResource[];
}

export interface RagSourceResource {
  source: string;
  chunks: number;
}

export interface ResourceCatalog {
  mcp: { configured: boolean; services: McpServiceResource[]; error?: string };
  rag: { sources: RagSourceResource[]; error?: string };
  sql?: {
    sources: Array<{
      id: string;
      name: string;
      connector: "mysql" | "postgresql";
      isDefault: boolean;
    }>;
    error?: string;
  };
}

export async function fetchResourceCatalog(): Promise<ResourceCatalog> {
  const response = await studioFetch("/api/resources");
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `资源目录请求失败（${response.status}）`);
  }
  return (await response.json()) as ResourceCatalog;
}
