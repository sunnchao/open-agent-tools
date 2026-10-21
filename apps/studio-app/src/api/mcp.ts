import { mcpFetch, gatewayFetch, getSettings } from "../lib/http";

export type VersionStatus =
  "DRAFT" | "VALIDATING" | "BUILDING" | "READY" | "FAILED" | "PUBLISHED" | "SUPERSEDED";
export type McpScope = "mcp:connect" | "tools:list" | "tools:call" | "prompts:list" | "prompts:get";
export interface McpService {
  id: string;
  name: string;
  slug: string;
  type: "MANAGED_MCP" | "REMOTE_MCP";
  status: "DRAFT" | "ACTIVE" | "DISABLED" | "DELETED";
  currentVersionId: string | null;
  revision: number;
}
export interface McpServiceEnvironment {
  environment: Record<string, null>;
  revision: number;
}
export interface McpTool {
  id: string;
  name: string;
  description?: string;
  handler: string;
  inputSchema: Record<string, unknown>;
}
export interface McpPrompt {
  id: string;
  name: string;
  title?: string;
  description?: string;
  arguments: Array<{ name: string; description?: string; required: boolean }>;
  messages: Array<{ role: "user" | "assistant"; content: { type: "text"; text: string } }>;
}
export interface McpExecutionLimits {
  timeoutMs: number;
  memoryMb: number;
  cpuMillis: number;
  network: "none" | "bridge";
}
export interface McpVersion {
  id: string;
  serviceId: string;
  versionNumber: number;
  status: VersionStatus;
  runtime: { name: "nodejs"; version: "20" } | null;
  entry: string | null;
  buildCommand: "npm run build" | null;
  limits: McpExecutionLimits | null;
  artifactDigest: string | null;
  artifactObjectKey: string | null;
  artifactSize: number | null;
  imageDigest: string | null;
  tools: McpTool[];
  prompts: McpPrompt[];
  revision: number;
}
export interface JobReference {
  id: string;
  kind?: "INSPECT" | "BUILD";
  status?: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
}
export interface BuildJobSummary {
  id: string;
  versionId: string;
  serviceId: string;
  serviceName: string;
  versionNumber: number;
  kind: "INSPECT" | "BUILD";
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  stage: string;
  errorCode: string | null;
}
export interface ApiClientRecord {
  id: string;
  name: string;
  createdAt: string;
}
export interface ApiKeyRecord {
  id: string;
  clientId: string;
  prefix: string;
  status: "ACTIVE" | "REVOKED";
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}
export interface ClientGrantRecord {
  id: string;
  clientId: string;
  serviceId: string;
  scopes: McpScope[];
  promptNames: string[] | null;
  toolNames: string[] | null;
  createdAt: string;
  updatedAt: string;
}
export interface AuditEventSummary {
  id: string;
  actorId: string;
  actorRole: "admin" | "operator" | "auditor" | "client";
  source: "control-plane" | "gateway";
  action: string;
  target: string;
  requestId: string;
  outcome: "SUCCEEDED" | "FAILED";
  statusCode: number;
  durationMs: number;
  createdAt: string;
}
export interface AuditEventRecord extends AuditEventSummary {
  input: unknown;
  output: unknown;
  context: unknown;
}
export type SlaWindow = "24h" | "7d";
export interface ToolSlaReport {
  window: SlaWindow;
  windowMinutes: number;
  generatedAt: string;
  serviceSlug: string | null;
  scan: { events: number; limit: number; truncated: boolean };
  totals: {
    calls: number;
    succeeded: number;
    failed: number;
    successRate: number;
    p95DurationMs: number;
  };
  services: Array<{
    serviceSlug: string;
    calls: number;
    succeeded: number;
    failed: number;
    successRate: number;
    p95DurationMs: number;
    tools: Array<{
      toolName: string;
      calls: number;
      succeeded: number;
      failed: number;
      successRate: number;
      p50DurationMs: number;
      p95DurationMs: number;
      maxDurationMs: number;
    }>;
  }>;
}
export interface MarketplaceService {
  id: string;
  name: string;
  slug: string;
  type: "MANAGED_MCP" | "REMOTE_MCP";
  versionId: string;
  versionNumber: number;
  toolCount: number | null;
  promptCount: number;
  toolsUnknown: boolean;
  tools: Array<{ name: string; description?: string }>;
  prompts: Array<{ name: string; title?: string }>;
}
export interface ClientQuotaRecord {
  id: string;
  clientId: string;
  serviceId: string | null;
  qpsLimit: number;
  dailyCallLimit: number;
  createdAt: string;
  updatedAt: string;
}
export interface UsageEventRecord {
  id: string;
  clientId: string;
  serviceId: string;
  versionId: string;
  toolName: string;
  requestId: string;
  status: "RESERVED" | "SUCCEEDED" | "FAILED";
  createdAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

export class McpApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "McpApiError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await mcpFetch(path, {
    ...init,
    headers: {
      ...((init.body === undefined ? {} : { "content-type": "application/json" }) as Record<
        string,
        string
      >),
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
  if (!response.ok) {
    let payload: { error?: { code?: string; message?: string } } | null = null;
    try {
      payload = (await response.json()) as { error?: { code?: string; message?: string } };
    } catch {
      /* ignore */
    }
    throw new McpApiError(
      response.status,
      payload?.error?.code ?? "HTTP_ERROR",
      payload?.error?.message ?? `MCP request failed (${response.status})`,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function listServices(): Promise<McpService[]> {
  return (await request<{ services: McpService[] }>("/services")).services;
}
export async function listMarketplaceServices(): Promise<MarketplaceService[]> {
  return (await request<{ services: MarketplaceService[] }>("/marketplace?limit=100")).services;
}
export async function getService(serviceId: string): Promise<McpService> {
  return (await request<{ service: McpService }>(`/services/${serviceId}`)).service;
}
export function getServiceEnvironment(serviceId: string): Promise<McpServiceEnvironment> {
  return request(`/services/${serviceId}/environment`);
}
export function updateServiceEnvironment(
  serviceId: string,
  expectedRevision: number,
  environment: Record<string, string | null>,
): Promise<McpServiceEnvironment> {
  return request(`/services/${serviceId}/environment`, {
    method: "PUT",
    body: JSON.stringify({ expectedRevision, environment }),
  });
}
export async function listVersions(serviceId: string): Promise<McpVersion[]> {
  return (await request<{ versions: McpVersion[] }>(`/services/${serviceId}/versions`)).versions;
}
export async function updateVersionLimits(
  serviceId: string,
  versionId: string,
  expectedRevision: number,
  limits: McpExecutionLimits,
): Promise<McpVersion> {
  return (
    await request<{ version: McpVersion }>(`/services/${serviceId}/versions/${versionId}/limits`, {
      method: "PUT",
      body: JSON.stringify({ expectedRevision, limits }),
    })
  ).version;
}
export async function createService(input: {
  name: string;
  slug: string;
}): Promise<{ service: McpService; draftVersion: McpVersion }> {
  return request("/services", {
    method: "POST",
    body: JSON.stringify({ ...input, type: "MANAGED_MCP" }),
  });
}
export async function updateService(
  serviceId: string,
  expectedRevision: number,
  patch: { name?: string; slug?: string },
): Promise<McpService> {
  return (
    await request<{ service: McpService }>(`/services/${serviceId}`, {
      method: "PATCH",
      body: JSON.stringify({ expectedRevision, ...patch }),
    })
  ).service;
}
export async function deleteService(serviceId: string, expectedRevision: number): Promise<void> {
  await request(`/services/${serviceId}`, {
    method: "DELETE",
    body: JSON.stringify({ expectedRevision }),
  });
}
export async function disableService(
  serviceId: string,
  expectedRevision: number,
): Promise<McpService> {
  return (
    await request<{ service: McpService }>(`/services/${serviceId}/disable`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision }),
    })
  ).service;
}
export async function enableService(
  serviceId: string,
  expectedRevision: number,
): Promise<McpService> {
  return (
    await request<{ service: McpService }>(`/services/${serviceId}/enable`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision }),
    })
  ).service;
}
export async function addTool(
  serviceId: string,
  versionId: string,
  input: {
    name: string;
    description?: string;
    handler: string;
    inputSchema: Record<string, unknown>;
  },
): Promise<McpTool> {
  return (
    await request<{ tool: McpTool }>(`/services/${serviceId}/versions/${versionId}/tools`, {
      method: "POST",
      body: JSON.stringify(input),
    })
  ).tool;
}
export async function updateTool(
  serviceId: string,
  versionId: string,
  toolId: string,
  input: {
    name: string;
    description?: string;
    handler: string;
    inputSchema: Record<string, unknown>;
  },
): Promise<McpTool> {
  return (
    await request<{ tool: McpTool }>(
      `/services/${serviceId}/versions/${versionId}/tools/${toolId}`,
      { method: "PUT", body: JSON.stringify(input) },
    )
  ).tool;
}
export async function deleteTool(
  serviceId: string,
  versionId: string,
  toolId: string,
): Promise<void> {
  await request(`/services/${serviceId}/versions/${versionId}/tools/${toolId}`, {
    method: "DELETE",
  });
}
export async function addPrompt(
  serviceId: string,
  versionId: string,
  input: {
    name: string;
    title?: string;
    description?: string;
    arguments: McpPrompt["arguments"];
    messages: McpPrompt["messages"];
  },
): Promise<McpPrompt> {
  return (
    await request<{ prompt: McpPrompt }>(`/services/${serviceId}/versions/${versionId}/prompts`, {
      method: "POST",
      body: JSON.stringify(input),
    })
  ).prompt;
}
export async function updatePrompt(
  serviceId: string,
  versionId: string,
  promptId: string,
  input: {
    name: string;
    title?: string;
    description?: string;
    arguments: McpPrompt["arguments"];
    messages: McpPrompt["messages"];
  },
): Promise<McpPrompt> {
  return (
    await request<{ prompt: McpPrompt }>(
      `/services/${serviceId}/versions/${versionId}/prompts/${promptId}`,
      { method: "PUT", body: JSON.stringify(input) },
    )
  ).prompt;
}
export async function deletePrompt(
  serviceId: string,
  versionId: string,
  promptId: string,
): Promise<void> {
  await request(`/services/${serviceId}/versions/${versionId}/prompts/${promptId}`, {
    method: "DELETE",
  });
}
export async function previewPrompt(
  serviceId: string,
  versionId: string,
  promptId: string,
  values: Record<string, string>,
): Promise<{ messages: McpPrompt["messages"] }> {
  return (
    await request<{ prompt: { messages: McpPrompt["messages"] } }>(
      `/services/${serviceId}/versions/${versionId}/prompts/${promptId}/preview`,
      { method: "POST", body: JSON.stringify({ arguments: values }) },
    )
  ).prompt;
}
export interface UploadFileInput {
  name: string;
  size: number;
  sha256: string;
  contentType?: string;
  data: Blob | Uint8Array | string;
}
export async function uploadArtifact(
  serviceId: string,
  versionId: string,
  expectedRevision: number,
  file: UploadFileInput,
): Promise<{ version: McpVersion; job: JobReference }> {
  const requested = await request<{
    objectKey: string;
    upload: { url: string; method: "PUT"; headers: Record<string, string> };
  }>(`/services/${serviceId}/versions/${versionId}/upload-url`, {
    method: "POST",
    body: JSON.stringify({ sha256: file.sha256, size: file.size }),
  });
  const body: BodyInit =
    file.data instanceof Uint8Array ? (file.data as unknown as BodyInit) : (file.data as BodyInit);
  const uploaded = await fetch(requested.upload.url, {
    method: requested.upload.method,
    headers: requested.upload.headers,
    body,
  });
  if (!uploaded.ok) throw new Error(`代码包上传失败 (${uploaded.status})`);
  return request(`/services/${serviceId}/versions/${versionId}/complete-upload`, {
    method: "POST",
    body: JSON.stringify({
      objectKey: requested.objectKey,
      sha256: file.sha256,
      size: file.size,
      expectedRevision,
    }),
  });
}
export function buildVersion(
  serviceId: string,
  versionId: string,
  expectedRevision: number,
): Promise<{ version: McpVersion; job: JobReference }> {
  return request(`/services/${serviceId}/versions/${versionId}/build`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision }),
  });
}
export async function validateVersion(
  serviceId: string,
  versionId: string,
  expectedRevision: number,
): Promise<McpVersion> {
  return (
    await request<{ version: McpVersion }>(
      `/services/${serviceId}/versions/${versionId}/validate`,
      { method: "POST", body: JSON.stringify({ expectedRevision }) },
    )
  ).version;
}
export async function resetVersionToDraft(
  serviceId: string,
  versionId: string,
  expectedRevision: number,
): Promise<McpVersion> {
  return (
    await request<{ version: McpVersion }>(
      `/services/${serviceId}/versions/${versionId}/reset-to-draft`,
      { method: "POST", body: JSON.stringify({ expectedRevision }) },
    )
  ).version;
}
export async function forkDraftVersion(serviceId: string, versionId: string): Promise<McpVersion> {
  return (
    await request<{ version: McpVersion }>(
      `/services/${serviceId}/versions/${versionId}/fork-draft`,
      { method: "POST", body: JSON.stringify({}) },
    )
  ).version;
}
export function publishVersion(
  serviceId: string,
  versionId: string,
  expectedRevision: number,
): Promise<{ service: McpService; version: McpVersion }> {
  return request(`/services/${serviceId}/versions/${versionId}/publish`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision }),
  });
}
export function rollbackVersion(
  serviceId: string,
  versionId: string,
  expectedRevision: number,
): Promise<{ service: McpService; version: McpVersion }> {
  return request(`/services/${serviceId}/versions/${versionId}/rollback`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision }),
  });
}
export async function listBuilds(): Promise<BuildJobSummary[]> {
  return (await request<{ builds: BuildJobSummary[] }>("/builds?limit=100")).builds;
}
export async function listClients(): Promise<ApiClientRecord[]> {
  return (await request<{ clients: ApiClientRecord[] }>("/clients")).clients;
}
export async function createClient(name: string): Promise<ApiClientRecord> {
  return (
    await request<{ client: ApiClientRecord }>("/clients", {
      method: "POST",
      body: JSON.stringify({ name }),
    })
  ).client;
}
export async function listApiKeys(clientId: string): Promise<ApiKeyRecord[]> {
  return (await request<{ keys: ApiKeyRecord[] }>(`/clients/${clientId}/keys`)).keys;
}
export function createApiKey(
  clientId: string,
  expiresAt?: string | null,
): Promise<{ key: ApiKeyRecord; rawKey: string }> {
  return request(`/clients/${clientId}/keys`, {
    method: "POST",
    body: JSON.stringify({ expiresAt: expiresAt ?? null }),
  });
}
export async function revokeApiKey(clientId: string, keyId: string): Promise<void> {
  await request(`/clients/${clientId}/keys/${keyId}`, { method: "DELETE" });
}
export async function listGrants(clientId: string): Promise<ClientGrantRecord[]> {
  return (await request<{ grants: ClientGrantRecord[] }>(`/clients/${clientId}/grants`)).grants;
}
export async function upsertGrant(
  clientId: string,
  serviceId: string,
  input: { scopes: McpScope[]; promptNames: string[] | null; toolNames: string[] | null },
): Promise<ClientGrantRecord> {
  return (
    await request<{ grant: ClientGrantRecord }>(`/clients/${clientId}/grants/${serviceId}`, {
      method: "PUT",
      body: JSON.stringify(input),
    })
  ).grant;
}
export async function deleteGrant(clientId: string, serviceId: string): Promise<void> {
  await request(`/clients/${clientId}/grants/${serviceId}`, { method: "DELETE" });
}
export async function listClientQuotas(clientId: string): Promise<ClientQuotaRecord[]> {
  return (await request<{ quotas: ClientQuotaRecord[] }>(`/clients/${clientId}/quotas`)).quotas;
}
export async function upsertClientQuota(
  clientId: string,
  input: { serviceId: string | null; qpsLimit: number; dailyCallLimit: number },
): Promise<ClientQuotaRecord> {
  return (
    await request<{ quota: ClientQuotaRecord }>(`/clients/${clientId}/quotas`, {
      method: "PUT",
      body: JSON.stringify(input),
    })
  ).quota;
}
export async function listClientUsage(
  clientId: string,
  filters: { serviceId?: string; from?: string; to?: string; limit?: number } = {},
): Promise<{
  events: UsageEventRecord[];
  summary: { total: number; reserved: number; succeeded: number; failed: number };
}> {
  const query = new URLSearchParams({ limit: String(filters.limit ?? 100) });
  if (filters.serviceId) query.set("serviceId", filters.serviceId);
  if (filters.from) query.set("from", filters.from);
  if (filters.to) query.set("to", filters.to);
  return request(`/clients/${clientId}/usage?${query}`);
}
export async function listAuditEvents(
  filters: { outcome?: AuditEventSummary["outcome"]; action?: string } = {},
): Promise<AuditEventSummary[]> {
  const query = new URLSearchParams({ limit: "100" });
  if (filters.outcome) query.set("outcome", filters.outcome);
  if (filters.action) query.set("action", filters.action);
  return (await request<{ events: AuditEventSummary[] }>(`/audit?${query}`)).events;
}
export async function getAuditEvent(eventId: string): Promise<AuditEventRecord> {
  return (await request<{ event: AuditEventRecord }>(`/audit/${encodeURIComponent(eventId)}`))
    .event;
}
export function buildToolSlaQuery(
  options: { window?: SlaWindow; serviceSlug?: string } = {},
): string {
  const query = new URLSearchParams({ window: options.window ?? "24h" });
  if (options.serviceSlug) query.set("serviceSlug", options.serviceSlug);
  return query.toString();
}
export async function getToolSla(
  options: { window?: SlaWindow; serviceSlug?: string } = {},
): Promise<ToolSlaReport> {
  return request<ToolSlaReport>(`/observability/tools?${buildToolSlaQuery(options)}`);
}

// Gateway 直调：RN 用纯 JSON-RPC over HTTP（Streamable），不依赖 SDK 的 GET 探测。
export interface GatewayToolCall {
  serviceSlug: string;
  apiKey: string;
  toolName: string;
  arguments: Record<string, unknown>;
}
export async function callGatewayTool(input: GatewayToolCall): Promise<unknown> {
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new Error("请输入 Gateway API Key");
  const response = await gatewayFetch(input.serviceSlug, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `rn-${Date.now()}`,
      method: "tools/call",
      params: { name: input.toolName, arguments: input.arguments },
    }),
  });
  const text = await response.text();
  // 兼容 JSON 直回与 SSE 包裝
  try {
    const parsed = JSON.parse(text) as { result?: unknown; error?: { message?: string } };
    if (parsed.error) throw new Error(parsed.error.message ?? "Gateway tool call failed");
    return parsed.result ?? parsed;
  } catch (err) {
    if (
      err instanceof Error &&
      err.message !== "Gateway tool call failed" &&
      !text.trim().startsWith("{")
    )
      throw err;
    // 尝试按 SSE 提取最后一个 data:
    const lines = text.split("\n").filter((l) => l.trim().startsWith("data:"));
    const last = lines[lines.length - 1]?.slice(5).trim();
    if (!last) throw new Error(`Gateway 调用失败 (HTTP ${response.status})`);
    const parsed = JSON.parse(last) as { result?: unknown; error?: { message?: string } };
    if (parsed.error) throw new Error(parsed.error.message ?? "Gateway tool call failed");
    return parsed.result ?? parsed;
  }
}
export async function getGatewaySettings(): Promise<{ gatewayUrl: string }> {
  const s = await getSettings();
  return { gatewayUrl: s.gatewayUrl };
}
