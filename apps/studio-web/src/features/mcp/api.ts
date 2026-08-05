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
  messages: Array<{
    role: "user" | "assistant";
    content: { type: "text"; text: string };
  }>;
}

export interface McpVersion {
  id: string;
  serviceId: string;
  versionNumber: number;
  status: VersionStatus;
  runtime: { name: "nodejs"; version: "20" } | null;
  entry: string | null;
  buildCommand: "npm run build" | null;
  limits: {
    timeoutMs: number;
    memoryMb: number;
    cpuMillis: number;
    network: "none";
  } | null;
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
  attempt: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface ApiClientRecord {
  id: string;
  name: string;
  status: "ACTIVE" | "REVOKED";
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ApiKeyRecord {
  id: string;
  clientId: string;
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

export interface AuditEventRecord {
  id: string;
  actorId: string;
  actorRole: "admin" | "operator" | "auditor";
  action: string;
  target: string;
  requestId: string;
  outcome: "SUCCEEDED" | "FAILED";
  statusCode: number;
  durationMs: number;
  createdAt: string;
}

interface ApiErrorBody {
  error?: { code?: string; message?: string };
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
  const response = await fetch(`/mcp-api${path}`, {
    ...init,
    headers: {
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as ApiErrorBody | null;
    throw new McpApiError(
      response.status,
      payload?.error?.code ?? "HTTP_ERROR",
      payload?.error?.message ?? `MCP request failed (${response.status})`,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function sha256(file: File): Promise<string> {
  const bytes =
    typeof file.arrayBuffer === "function"
      ? await file.arrayBuffer()
      : await new Response(file).arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

export async function listServices(): Promise<McpService[]> {
  return (await request<{ services: McpService[] }>("/services")).services;
}

export async function getService(serviceId: string): Promise<McpService> {
  return (await request<{ service: McpService }>(`/services/${serviceId}`)).service;
}

export async function listVersions(serviceId: string): Promise<McpVersion[]> {
  return (await request<{ versions: McpVersion[] }>(`/services/${serviceId}/versions`)).versions;
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
  expectedRevision: number,
  tool: Omit<McpTool, "id">,
): Promise<McpVersion> {
  return (
    await request<{ version: McpVersion }>(`/services/${serviceId}/versions/${versionId}/tools`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision, tool }),
    })
  ).version;
}

export async function updateTool(
  serviceId: string,
  versionId: string,
  toolId: string,
  expectedRevision: number,
  tool: Partial<Omit<McpTool, "id">>,
): Promise<McpVersion> {
  return (
    await request<{ version: McpVersion }>(
      `/services/${serviceId}/versions/${versionId}/tools/${toolId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ expectedRevision, tool }),
      },
    )
  ).version;
}

export async function deleteTool(
  serviceId: string,
  versionId: string,
  toolId: string,
  expectedRevision: number,
): Promise<void> {
  await request(`/services/${serviceId}/versions/${versionId}/tools/${toolId}`, {
    method: "DELETE",
    body: JSON.stringify({ expectedRevision }),
  });
}

export async function addPrompt(
  serviceId: string,
  versionId: string,
  expectedRevision: number,
  prompt: Omit<McpPrompt, "id">,
): Promise<McpVersion> {
  return (
    await request<{ version: McpVersion }>(`/services/${serviceId}/versions/${versionId}/prompts`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision, prompt }),
    })
  ).version;
}

export async function updatePrompt(
  serviceId: string,
  versionId: string,
  promptId: string,
  expectedRevision: number,
  prompt: Partial<Omit<McpPrompt, "id">>,
): Promise<McpVersion> {
  return (
    await request<{ version: McpVersion }>(
      `/services/${serviceId}/versions/${versionId}/prompts/${promptId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ expectedRevision, prompt }),
      },
    )
  ).version;
}

export async function deletePrompt(
  serviceId: string,
  versionId: string,
  promptId: string,
  expectedRevision: number,
): Promise<void> {
  await request(`/services/${serviceId}/versions/${versionId}/prompts/${promptId}`, {
    method: "DELETE",
    body: JSON.stringify({ expectedRevision }),
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

export async function uploadArtifact(
  serviceId: string,
  versionId: string,
  expectedRevision: number,
  file: File,
): Promise<{ version: McpVersion; job: JobReference }> {
  const digest = await sha256(file);
  const requested = await request<{
    objectKey: string;
    upload: { url: string; method: "PUT"; headers: Record<string, string> };
  }>(`/services/${serviceId}/versions/${versionId}/upload-url`, {
    method: "POST",
    body: JSON.stringify({ sha256: digest, size: file.size }),
  });
  const uploaded = await fetch(requested.upload.url, {
    method: requested.upload.method,
    headers: requested.upload.headers,
    body: file,
  });
  if (!uploaded.ok) throw new Error(`代码包上传失败 (${uploaded.status})`);
  return request(`/services/${serviceId}/versions/${versionId}/complete-upload`, {
    method: "POST",
    body: JSON.stringify({
      objectKey: requested.objectKey,
      sha256: digest,
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

export async function listAuditEvents(
  filters: { outcome?: AuditEventRecord["outcome"]; action?: string } = {},
): Promise<AuditEventRecord[]> {
  const query = new URLSearchParams({ limit: "100" });
  if (filters.outcome) query.set("outcome", filters.outcome);
  if (filters.action) query.set("action", filters.action);
  return (await request<{ events: AuditEventRecord[] }>(`/audit?${query}`)).events;
}
