import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions/completions";

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

export interface McpToolBinding {
  serviceSlug: string;
  toolName: string;
}

export interface ResourceBindings {
  mcpTools: McpToolBinding[];
  rag: { sources: string[]; topK: number };
}

export interface ResourceBindingsInput {
  mcpTools?: McpToolBinding[];
  rag?: { sources?: string[]; topK?: number };
}

export interface ResolvedMcpTool extends McpToolBinding {
  alias: string;
  definition: ChatCompletionFunctionTool;
}

interface GatewayServiceSummary {
  serviceSlug: string;
  serviceStatus: string;
  versionStatus: string;
  scopes: string[];
}

export function normalizeResourceBindings(value?: ResourceBindingsInput): ResourceBindings {
  const tools = value?.mcpTools ?? [];
  const sources = value?.rag?.sources ?? [];
  if (
    tools.length > 30 ||
    tools.some(
      (tool) =>
        !tool ||
        typeof tool.serviceSlug !== "string" ||
        !tool.serviceSlug.trim() ||
        typeof tool.toolName !== "string" ||
        !tool.toolName.trim(),
    )
  ) {
    throw new Error("mcpTools must contain at most 30 valid bindings");
  }
  if (
    sources.length > 50 ||
    sources.some((source) => typeof source !== "string" || !source.trim())
  ) {
    throw new Error("RAG sources must contain at most 50 valid source names");
  }

  const uniqueTools = new Map<string, McpToolBinding>();
  tools.forEach((tool) => {
    const binding = {
      serviceSlug: tool.serviceSlug.trim(),
      toolName: tool.toolName.trim(),
    };
    uniqueTools.set(`${binding.serviceSlug}:${binding.toolName}`, binding);
  });

  const topK = Math.max(1, Math.min(20, Math.floor(Number(value?.rag?.topK) || 5)));
  return {
    mcpTools: [...uniqueTools.values()],
    rag: { sources: [...new Set(sources.map((source) => source.trim()))], topK },
  };
}

function resourceConfig() {
  return {
    gatewayUrl: (process.env.MCP_GATEWAY_URL ?? "http://localhost:4100").replace(/\/$/, ""),
    gatewayApiKey: process.env.MCP_GATEWAY_API_KEY?.trim() ?? "",
    ragApiUrl: (process.env.RAG_API_URL ?? "http://localhost:4001/api").replace(/\/$/, ""),
  };
}

async function gatewayServices(): Promise<GatewayServiceSummary[]> {
  const { gatewayApiKey, gatewayUrl } = resourceConfig();
  if (!gatewayApiKey) return [];
  const response = await fetch(`${gatewayUrl}/mcp/services`, {
    headers: { authorization: `Bearer ${gatewayApiKey}` },
  });
  if (!response.ok) throw new Error(`Gateway resource request failed (${response.status})`);
  return ((await response.json()) as { services: GatewayServiceSummary[] }).services;
}

async function withMcpClient<T>(
  serviceSlug: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const { gatewayApiKey, gatewayUrl } = resourceConfig();
  if (!gatewayApiKey) throw new Error("MCP Gateway API Key is not configured");
  const client = new Client({ name: "open-agent-studio-server", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${gatewayUrl}/mcp/services/${encodeURIComponent(serviceSlug)}`),
    { requestInit: { headers: { authorization: `Bearer ${gatewayApiKey}` } } },
  );
  try {
    await client.connect(transport);
    return await run(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function listMcpResources(): Promise<McpServiceResource[]> {
  const services = await gatewayServices();
  const available = services.filter(
    (service) =>
      service.serviceStatus === "ACTIVE" &&
      service.versionStatus === "PUBLISHED" &&
      service.scopes.includes("tools:list") &&
      service.scopes.includes("tools:call"),
  );
  return Promise.all(
    available.map(async (service) => {
      const result = await withMcpClient(service.serviceSlug, (client) => client.listTools());
      return {
        serviceSlug: service.serviceSlug,
        serviceStatus: service.serviceStatus,
        versionStatus: service.versionStatus,
        tools: result.tools.map((tool) => ({
          serviceSlug: service.serviceSlug,
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          inputSchema: tool.inputSchema as Record<string, unknown>,
        })),
      };
    }),
  );
}

async function listRagSources(): Promise<RagSourceResource[]> {
  const { ragApiUrl } = resourceConfig();
  const response = await fetch(`${ragApiUrl}/documents`);
  if (!response.ok) throw new Error(`RAG resource request failed (${response.status})`);
  return ((await response.json()) as { sources: RagSourceResource[] }).sources;
}

export async function loadResourceCatalog(): Promise<ResourceCatalog> {
  const { gatewayApiKey } = resourceConfig();
  const [mcp, rag] = await Promise.allSettled([listMcpResources(), listRagSources()]);
  return {
    mcp:
      mcp.status === "fulfilled"
        ? { configured: Boolean(gatewayApiKey), services: mcp.value }
        : { configured: Boolean(gatewayApiKey), services: [], error: String(mcp.reason) },
    rag:
      rag.status === "fulfilled"
        ? { sources: rag.value }
        : { sources: [], error: String(rag.reason) },
  };
}

export function toolAlias(binding: McpToolBinding): string {
  const hash = createHash("sha1")
    .update(`${binding.serviceSlug}:${binding.toolName}`)
    .digest("hex")
    .slice(0, 8);
  const readable = binding.toolName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
  return `mcp_${hash}_${readable}`;
}

export async function resolveMcpTools(bindings: McpToolBinding[]): Promise<ResolvedMcpTool[]> {
  if (bindings.length === 0) return [];
  const catalog = await listMcpResources();
  return resolveMcpToolsFromCatalog(bindings, catalog);
}

export function resolveMcpToolsFromCatalog(
  bindings: McpToolBinding[],
  catalog: McpServiceResource[],
): ResolvedMcpTool[] {
  const tools = new Map(
    catalog.flatMap((service) =>
      service.tools.map((tool) => [`${service.serviceSlug}:${tool.name}`, tool] as const),
    ),
  );
  const resolved: ResolvedMcpTool[] = [];
  for (const binding of bindings) {
    const tool = tools.get(`${binding.serviceSlug}:${binding.toolName}`);
    if (!tool)
      throw new Error(`MCP Tool is unavailable: ${binding.serviceSlug}/${binding.toolName}`);
    const alias = toolAlias(binding);
    resolved.push({
      ...binding,
      alias,
      definition: {
        type: "function",
        function: {
          name: alias,
          description: `[MCP ${binding.serviceSlug}] ${tool.description ?? tool.name}`,
          parameters: tool.inputSchema,
        },
      },
    });
  }
  return resolved;
}

export async function callMcpTool(
  binding: McpToolBinding,
  args: Record<string, unknown>,
): Promise<unknown> {
  return withMcpClient(binding.serviceSlug, (client) =>
    client.callTool({ name: binding.toolName, arguments: args }),
  );
}

export async function retrieveRag(input: {
  query: string;
  sources: string[];
  topK: number;
  signal?: AbortSignal;
}): Promise<{ chunks: Array<Record<string, unknown>>; formatted: string }> {
  if (input.sources.length === 0) return { chunks: [], formatted: "" };
  const { ragApiUrl } = resourceConfig();
  const { signal, ...payload } = input;
  const response = await fetch(`${ragApiUrl}/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, generate: false }),
    signal,
  });
  if (!response.ok) throw new Error(`RAG retrieval failed (${response.status})`);
  const body = (await response.json()) as {
    chunks: Array<
      { source: string; chunkIndex: number; content: string } & Record<string, unknown>
    >;
  };
  return {
    chunks: body.chunks,
    formatted: body.chunks
      .map((chunk) => `【来源: ${chunk.source} · 第${chunk.chunkIndex + 1}段】\n${chunk.content}`)
      .join("\n\n"),
  };
}
