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
