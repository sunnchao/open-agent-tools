import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions/completions";
import { getMcpGatewayCredentials } from "./mcpGateway/store.js";
import { listSchemaSources } from "./schemaSources/store.js";

export interface SqlSourceResource {
  id: string;
  name: string;
  connector: "mysql" | "postgresql";
  isDefault: boolean;
}

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
  sql?: { sources: SqlSourceResource[]; error?: string };
}

export interface McpToolBinding {
  serviceSlug: string;
  toolName: string;
}

export interface ResourceBindings {
  mcpTools: McpToolBinding[];
  rag: { sources: string[]; topK: number };
  /** 绑定的 SQL 问数数据源，服务端校验存在且启用。 */
  sqlSources: string[];
}

export interface ResourceBindingsInput {
  mcpTools?: McpToolBinding[];
  rag?: { sources?: string[]; topK?: number };
  sqlSources?: string[];
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
  const sqlSources = value?.sqlSources ?? [];
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
  if (
    !Array.isArray(sqlSources) ||
    sqlSources.length > 20 ||
    sqlSources.some((source) => typeof source !== "string" || !source.trim())
  ) {
    throw new Error("sqlSources must contain at most 20 valid source ids");
  }
  const uniqueSqlSources = [...new Set(sqlSources.map((source) => source.trim()))];
  if (uniqueSqlSources.length > 0) {
    const available = new Set(listSchemaSources().map((source) => source.id));
    if (uniqueSqlSources.some((id) => !available.has(id))) {
      throw new Error("invalid sqlSources: schema source not found or disabled");
    }
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
    sqlSources: uniqueSqlSources,
  };
}

function resourceConfig() {
  const gateway = getMcpGatewayCredentials();
  return {
    gatewayUrl: gateway.gatewayUrl,
    gatewayApiKey: gateway.gatewayApiKey,
    ragApiUrl: (process.env.RAG_API_URL ?? "http://localhost:4001/api").replace(/\/$/, ""),
    ragRuntimeToken: process.env.RAG_RUNTIME_TOKEN?.trim() ?? "",
    ragAdminToken: process.env.RAG_ADMIN_TOKEN?.trim() ?? "",
  };
}

function ragHeaders(
  config: ReturnType<typeof resourceConfig>,
  scope: "runtime" | "admin",
  contentType = false,
): Record<string, string> {
  const token = scope === "runtime" ? config.ragRuntimeToken : config.ragAdminToken;
  return {
    ...(contentType ? { "content-type": "application/json" } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function gatewayServices(): Promise<GatewayServiceSummary[]> {
  const { gatewayApiKey, gatewayUrl } = resourceConfig();
  if (!gatewayApiKey) return [];
  const response = await fetch(`${gatewayUrl}/mcp/services`, {
    headers: { authorization: `Bearer ${gatewayApiKey}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Gateway resource request failed (${response.status})`);
  return ((await response.json()) as { services: GatewayServiceSummary[] }).services;
}

async function withMcpClient<T>(
  serviceSlug: string,
  run: (client: Client) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const { gatewayApiKey, gatewayUrl } = resourceConfig();
  if (!gatewayApiKey) throw new Error("MCP Gateway API Key is not configured");
  const client = new Client({ name: "open-agent-studio-server", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${gatewayUrl}/mcp/services/${encodeURIComponent(serviceSlug)}`),
    { requestInit: { headers: { authorization: `Bearer ${gatewayApiKey}` }, signal } },
  );
  const abort = () => {
    void client.close().catch(() => undefined);
  };
  if (signal?.aborted) throw new Error("workflow run cancelled");
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await client.connect(transport);
    return await run(client);
  } finally {
    signal?.removeEventListener("abort", abort);
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
  const config = resourceConfig();
  const response = await fetch(`${config.ragApiUrl}/documents`, {
    headers: ragHeaders(config, "admin"),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`RAG resource request failed (${response.status})`);
  return ((await response.json()) as { sources: RagSourceResource[] }).sources;
}

export async function loadResourceCatalog(): Promise<ResourceCatalog> {
  const { gatewayApiKey } = resourceConfig();
  const [mcp, rag] = await Promise.allSettled([listMcpResources(), listRagSources()]);
  let sql: NonNullable<ResourceCatalog["sql"]>;
  try {
    sql = {
      sources: listSchemaSources().map(({ id, name, connector, isDefault }) => ({
        id,
        name,
        connector,
        isDefault,
      })),
    };
  } catch (error) {
    sql = { sources: [], error: error instanceof Error ? error.message : String(error) };
  }
  return {
    sql,
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
  options?: { signal?: AbortSignal },
): Promise<unknown> {
  return withMcpClient(
    binding.serviceSlug,
    (client) =>
      client.callTool({ name: binding.toolName, arguments: args }, undefined, {
        signal: options?.signal,
      }),
    options?.signal,
  );
}

/** rag-server /api/query 返回的图谱增强上下文；旧版服务端没有 graph 字段。 */
export interface RagGraphContext {
  enabled?: boolean;
  seeds?: Array<{ id: string; name: string; type?: string }>;
  entities?: number;
  relations?: number;
  chunkHits?: number;
  context?: string;
}

export interface RagQueryResponseBody {
  queryId?: string;
  retrieval?: unknown;
  chunks: Array<{ source: string; chunkIndex: number; content: string } & Record<string, unknown>>;
  graph?: RagGraphContext;
}

export interface RagRetrievalResult {
  queryId?: string;
  chunks: Array<Record<string, unknown>>;
  formatted: string;
  graph?: RagGraphContext;
  retrieval?: unknown;
}

/**
 * 把 /api/query 响应映射为 Agent Server 的检索结果。
 *
 * 抽成纯函数是为了让「图谱上下文如何进入注入文本」可被单测覆盖；同时保证
 * 老版 rag-server（无 graph 字段）的 formatted 与历史实现逐字节一致，避免行为漂移。
 */
export function formatRagRetrieval(
  body: RagQueryResponseBody,
): Pick<RagRetrievalResult, "chunks" | "formatted" | "graph"> {
  const chunks = body.chunks;
  const chunksText = chunks
    .map((chunk) => `【来源: ${chunk.source} · 第${chunk.chunkIndex + 1}段】\n${chunk.content}`)
    .join("\n\n");
  // 图谱上下文没有 source/chunkIndex，不能伪造成引用分块，只能作为独立区块追加到注入文本。
  // trim 仅用于判定「是否非空」，实际注入保留上游返回的原始排版。
  const graphContext = body.graph?.context;
  const graphText =
    typeof graphContext === "string" && graphContext.trim().length > 0
      ? `【知识图谱】\n${graphContext}`
      : "";
  return {
    chunks,
    // 用数组 join 而不是直接字符串拼接：chunks 为空时不会凭空多出前导空行；
    // 无 graph.context 时 graphText 为空被过滤，结果与旧实现逐字节一致。
    formatted: [chunksText, graphText].filter(Boolean).join("\n\n"),
    // graph 原样透传；缺失时不生成 graph: undefined，保持与旧服务端的返回形状一致。
    ...(body.graph ? { graph: body.graph } : {}),
  };
}

export async function retrieveRag(input: {
  query: string;
  sources: string[];
  topK: number;
  viewerGroups?: string[];
  /** 是否启用图谱增强；缺省交给 rag-server 决定（新版默认开启，旧版忽略该字段）。 */
  graph?: boolean;
  /** 图谱子图扩展跳数（1-4）；缺省由 rag-server 用默认 2 跳。旧版服务端会忽略该字段。 */
  graphHops?: number;
  signal?: AbortSignal;
}): Promise<RagRetrievalResult> {
  if (input.sources.length === 0) return { chunks: [], formatted: "" };
  const config = resourceConfig();
  const { signal, ...payload } = input;
  const response = await fetch(`${config.ragApiUrl}/query`, {
    method: "POST",
    headers: ragHeaders(config, "runtime", true),
    body: JSON.stringify({ ...payload, generate: false }),
    signal,
  });
  if (!response.ok) throw new Error(`RAG retrieval failed (${response.status})`);
  const body = (await response.json()) as RagQueryResponseBody;
  // 统一走纯函数：formatted 的图谱拼接只保留一处实现，测试与运行时不会分叉。
  const { chunks, formatted, graph } = formatRagRetrieval(body);
  return {
    ...(body.queryId ? { queryId: body.queryId } : {}),
    chunks,
    formatted,
    ...(graph ? { graph } : {}),
    ...(body.retrieval !== undefined ? { retrieval: body.retrieval } : {}),
  };
}

/** 图谱子图检索（rag-server /api/graph/retrieve）。子图未命中时返回空。 */
export async function retrieveRagGraph(input: {
  query: string;
  sources?: string[];
  viewerGroups?: string[];
  signal?: AbortSignal;
}): Promise<{ formatted: string; seeds: Array<{ id: string; name: string }> }> {
  const config = resourceConfig();
  const response = await fetch(`${config.ragApiUrl}/graph/retrieve`, {
    method: "POST",
    headers: ragHeaders(config, "runtime", true),
    body: JSON.stringify({
      query: input.query,
      maxHops: 2,
      ...(input.sources ? { sources: input.sources } : {}),
      ...(input.viewerGroups !== undefined ? { viewerGroups: input.viewerGroups } : {}),
    }),
    signal: input.signal,
  });
  if (!response.ok) {
    if (response.status === 404) return { formatted: "", seeds: [] }; // 老版本 rag-server 无图谱能力，优雅降级
    throw new Error(`Graph retrieval failed (${response.status})`);
  }
  const body = (await response.json()) as {
    formatted?: string;
    seeds?: Array<{ id: string; name: string }>;
  };
  return { formatted: body.formatted ?? "", seeds: body.seeds ?? [] };
}
