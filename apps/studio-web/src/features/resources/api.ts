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
}

export async function fetchResourceCatalog(): Promise<ResourceCatalog> {
  const response = await fetch("/api/resources");
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `资源目录请求失败（${response.status}）`);
  }
  return (await response.json()) as ResourceCatalog;
}
