export type AdminRole = "admin" | "operator" | "auditor";
export type McpScope = "mcp:connect" | "tools:list" | "tools:call" | "prompts:list" | "prompts:get";
export type VersionStatus =
  "DRAFT" | "VALIDATING" | "BUILDING" | "READY" | "FAILED" | "PUBLISHED" | "SUPERSEDED";

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
  id?: string;
  name: string;
  description?: string;
  handler: string;
  inputSchema: Record<string, unknown>;
}

export interface PromptArgument {
  name: string;
  description?: string;
  required: boolean;
}

export interface PromptMessage {
  role: "user" | "assistant";
  content: { type: "text"; text: string };
}

export interface McpPrompt {
  id?: string;
  name: string;
  title?: string;
  description?: string;
  arguments: PromptArgument[];
  messages: PromptMessage[];
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
  tools: Array<McpTool & { id: string }>;
  prompts: Array<McpPrompt & { id: string }>;
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
  actorRole: AdminRole;
  action: string;
  target: string;
  requestId: string;
  outcome: "SUCCEEDED" | "FAILED";
  statusCode: number;
  durationMs: number;
  createdAt: string;
}

export interface McpAdminApi {
  listServices(): Promise<McpService[]>;
  getService(serviceId: string): Promise<McpService>;
  listVersions(serviceId: string): Promise<McpVersion[]>;
  createService(input: {
    name: string;
    slug: string;
  }): Promise<{ service: McpService; draftVersion: McpVersion }>;
  updateService(
    serviceId: string,
    expectedRevision: number,
    patch: { name?: string; slug?: string },
  ): Promise<McpService>;
  disableService(serviceId: string, expectedRevision: number): Promise<McpService>;
  enableService(serviceId: string, expectedRevision: number): Promise<McpService>;
  deleteService(serviceId: string, expectedRevision: number): Promise<void>;
  addTool(
    serviceId: string,
    versionId: string,
    revision: number,
    tool: McpTool,
  ): Promise<McpVersion>;
  updateTool(
    serviceId: string,
    versionId: string,
    toolId: string,
    revision: number,
    tool: Partial<McpTool>,
  ): Promise<McpVersion>;
  deleteTool(serviceId: string, versionId: string, toolId: string, revision: number): Promise<void>;
  addPrompt(
    serviceId: string,
    versionId: string,
    revision: number,
    prompt: McpPrompt,
  ): Promise<McpVersion>;
  updatePrompt(
    serviceId: string,
    versionId: string,
    promptId: string,
    revision: number,
    prompt: Partial<McpPrompt>,
  ): Promise<McpVersion>;
  deletePrompt(
    serviceId: string,
    versionId: string,
    promptId: string,
    revision: number,
  ): Promise<void>;
  previewPrompt(
    serviceId: string,
    versionId: string,
    promptId: string,
    argumentsByName: Record<string, string>,
  ): Promise<{ messages: PromptMessage[] }>;
  uploadArtifact(
    serviceId: string,
    versionId: string,
    revision: number,
    file: File,
  ): Promise<{ version: McpVersion; job: JobReference }>;
  buildVersion(
    serviceId: string,
    versionId: string,
    revision: number,
  ): Promise<{ version: McpVersion; job: JobReference }>;
  validateVersion(serviceId: string, versionId: string, revision: number): Promise<McpVersion>;
  resetVersionToDraft(
    serviceId: string,
    versionId: string,
    revision: number,
  ): Promise<McpVersion>;
  forkDraftVersion(serviceId: string, versionId: string): Promise<McpVersion>;
  publishVersion(
    serviceId: string,
    versionId: string,
    revision: number,
  ): Promise<{ service: McpService; version: McpVersion }>;
  rollbackVersion(
    serviceId: string,
    versionId: string,
    revision: number,
  ): Promise<{ service: McpService; version: McpVersion }>;
  listBuilds(): Promise<BuildJobSummary[]>;
  listClients(): Promise<ApiClientRecord[]>;
  createClient(name: string): Promise<ApiClientRecord>;
  listApiKeys(clientId: string): Promise<ApiKeyRecord[]>;
  createApiKey(
    clientId: string,
    expiresAt?: string | null,
  ): Promise<{ key: ApiKeyRecord; rawKey: string }>;
  revokeApiKey(clientId: string, keyId: string): Promise<void>;
  listGrants(clientId: string): Promise<ClientGrantRecord[]>;
  upsertGrant(
    clientId: string,
    serviceId: string,
    input: { scopes: McpScope[]; promptNames: string[] | null; toolNames: string[] | null },
  ): Promise<ClientGrantRecord>;
  deleteGrant(clientId: string, serviceId: string): Promise<void>;
  listAuditEvents(filters?: {
    outcome?: "SUCCEEDED" | "FAILED";
    action?: string;
  }): Promise<AuditEventRecord[]>;
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

async function sha256(file: File): Promise<string> {
  const bytes =
    typeof file.arrayBuffer === "function"
      ? await file.arrayBuffer()
      : await new Response(file).arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export interface McpApiClientOptions {
  baseUrl?: string;
}

export class McpApiClient implements McpAdminApi {
  readonly #baseUrl: string;

  constructor(options: McpApiClientOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? "/api/admin/mcp").replace(/\/$/, "");
  }

  async #request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: { code?: string; message?: string };
      } | null;
      throw new McpApiError(
        response.status,
        payload?.error?.code ?? "HTTP_ERROR",
        payload?.error?.message ?? `Request failed with status ${response.status}`,
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async listServices() {
    return (await this.#request<{ services: McpService[] }>("/services")).services;
  }

  async getService(serviceId: string) {
    return (await this.#request<{ service: McpService }>(`/services/${serviceId}`)).service;
  }

  async listVersions(serviceId: string) {
    return (await this.#request<{ versions: McpVersion[] }>(`/services/${serviceId}/versions`))
      .versions;
  }

  createService(input: { name: string; slug: string }) {
    return this.#request<{ service: McpService; draftVersion: McpVersion }>("/services", {
      method: "POST",
      body: JSON.stringify({ ...input, type: "MANAGED_MCP" }),
    });
  }

  async updateService(
    serviceId: string,
    expectedRevision: number,
    patch: { name?: string; slug?: string },
  ) {
    return (
      await this.#request<{ service: McpService }>(`/services/${serviceId}`, {
        method: "PATCH",
        body: JSON.stringify({ expectedRevision, ...patch }),
      })
    ).service;
  }

  async deleteService(serviceId: string, expectedRevision: number) {
    await this.#request(`/services/${serviceId}`, {
      method: "DELETE",
      body: JSON.stringify({ expectedRevision }),
    });
  }

  async disableService(serviceId: string, expectedRevision: number) {
    return (
      await this.#request<{ service: McpService }>(`/services/${serviceId}/disable`, {
        method: "POST",
        body: JSON.stringify({ expectedRevision }),
      })
    ).service;
  }

  async enableService(serviceId: string, expectedRevision: number) {
    return (
      await this.#request<{ service: McpService }>(`/services/${serviceId}/enable`, {
        method: "POST",
        body: JSON.stringify({ expectedRevision }),
      })
    ).service;
  }

  async addTool(serviceId: string, versionId: string, expectedRevision: number, tool: McpTool) {
    return (
      await this.#request<{ version: McpVersion }>(
        `/services/${serviceId}/versions/${versionId}/tools`,
        { method: "POST", body: JSON.stringify({ expectedRevision, tool }) },
      )
    ).version;
  }

  async updateTool(
    serviceId: string,
    versionId: string,
    toolId: string,
    expectedRevision: number,
    tool: Partial<McpTool>,
  ) {
    return (
      await this.#request<{ version: McpVersion }>(
        `/services/${serviceId}/versions/${versionId}/tools/${toolId}`,
        { method: "PATCH", body: JSON.stringify({ expectedRevision, tool }) },
      )
    ).version;
  }

  async deleteTool(serviceId: string, versionId: string, toolId: string, expectedRevision: number) {
    await this.#request(`/services/${serviceId}/versions/${versionId}/tools/${toolId}`, {
      method: "DELETE",
      body: JSON.stringify({ expectedRevision }),
    });
  }

  async addPrompt(
    serviceId: string,
    versionId: string,
    expectedRevision: number,
    prompt: McpPrompt,
  ) {
    return (
      await this.#request<{ version: McpVersion }>(
        `/services/${serviceId}/versions/${versionId}/prompts`,
        { method: "POST", body: JSON.stringify({ expectedRevision, prompt }) },
      )
    ).version;
  }

  async updatePrompt(
    serviceId: string,
    versionId: string,
    promptId: string,
    expectedRevision: number,
    prompt: Partial<McpPrompt>,
  ) {
    return (
      await this.#request<{ version: McpVersion }>(
        `/services/${serviceId}/versions/${versionId}/prompts/${promptId}`,
        { method: "PATCH", body: JSON.stringify({ expectedRevision, prompt }) },
      )
    ).version;
  }

  async deletePrompt(
    serviceId: string,
    versionId: string,
    promptId: string,
    expectedRevision: number,
  ) {
    await this.#request(`/services/${serviceId}/versions/${versionId}/prompts/${promptId}`, {
      method: "DELETE",
      body: JSON.stringify({ expectedRevision }),
    });
  }

  async previewPrompt(
    serviceId: string,
    versionId: string,
    promptId: string,
    argumentsByName: Record<string, string>,
  ) {
    return (
      await this.#request<{ prompt: { messages: PromptMessage[] } }>(
        `/services/${serviceId}/versions/${versionId}/prompts/${promptId}/preview`,
        { method: "POST", body: JSON.stringify({ arguments: argumentsByName }) },
      )
    ).prompt;
  }

  async uploadArtifact(serviceId: string, versionId: string, expectedRevision: number, file: File) {
    const digest = await sha256(file);
    const requested = await this.#request<{
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
    if (!uploaded.ok) {
      throw new McpApiError(uploaded.status, "UPLOAD_FAILED", "Package upload failed");
    }
    return this.#request<{ version: McpVersion; job: JobReference }>(
      `/services/${serviceId}/versions/${versionId}/complete-upload`,
      {
        method: "POST",
        body: JSON.stringify({
          objectKey: requested.objectKey,
          sha256: digest,
          size: file.size,
          expectedRevision,
        }),
      },
    );
  }

  buildVersion(serviceId: string, versionId: string, expectedRevision: number) {
    return this.#request<{ version: McpVersion; job: JobReference }>(
      `/services/${serviceId}/versions/${versionId}/build`,
      { method: "POST", body: JSON.stringify({ expectedRevision }) },
    );
  }

  async validateVersion(serviceId: string, versionId: string, expectedRevision: number) {
    return (
      await this.#request<{ version: McpVersion }>(
        `/services/${serviceId}/versions/${versionId}/validate`,
        { method: "POST", body: JSON.stringify({ expectedRevision }) },
      )
    ).version;
  }

  async resetVersionToDraft(serviceId: string, versionId: string, expectedRevision: number) {
    return (
      await this.#request<{ version: McpVersion }>(
        `/services/${serviceId}/versions/${versionId}/reset-to-draft`,
        { method: "POST", body: JSON.stringify({ expectedRevision }) },
      )
    ).version;
  }

  async forkDraftVersion(serviceId: string, versionId: string) {
    return (
      await this.#request<{ version: McpVersion }>(
        `/services/${serviceId}/versions/${versionId}/fork-draft`,
        { method: "POST", body: JSON.stringify({}) },
      )
    ).version;
  }

  publishVersion(serviceId: string, versionId: string, expectedRevision: number) {
    return this.#request<{ service: McpService; version: McpVersion }>(
      `/services/${serviceId}/versions/${versionId}/publish`,
      { method: "POST", body: JSON.stringify({ expectedRevision }) },
    );
  }

  rollbackVersion(serviceId: string, versionId: string, expectedRevision: number) {
    return this.#request<{ service: McpService; version: McpVersion }>(
      `/services/${serviceId}/versions/${versionId}/rollback`,
      { method: "POST", body: JSON.stringify({ expectedRevision }) },
    );
  }

  async listBuilds() {
    return (await this.#request<{ builds: BuildJobSummary[] }>("/builds?limit=100")).builds;
  }

  async listClients() {
    return (await this.#request<{ clients: ApiClientRecord[] }>("/clients")).clients;
  }

  async createClient(name: string) {
    return (
      await this.#request<{ client: ApiClientRecord }>("/clients", {
        method: "POST",
        body: JSON.stringify({ name }),
      })
    ).client;
  }

  async listApiKeys(clientId: string) {
    return (await this.#request<{ keys: ApiKeyRecord[] }>(`/clients/${clientId}/keys`)).keys;
  }

  createApiKey(clientId: string, expiresAt?: string | null) {
    return this.#request<{ key: ApiKeyRecord; rawKey: string }>(`/clients/${clientId}/keys`, {
      method: "POST",
      body: JSON.stringify({ expiresAt: expiresAt ?? null }),
    });
  }

  async revokeApiKey(clientId: string, keyId: string) {
    await this.#request(`/clients/${clientId}/keys/${keyId}`, { method: "DELETE" });
  }

  async listGrants(clientId: string) {
    return (await this.#request<{ grants: ClientGrantRecord[] }>(`/clients/${clientId}/grants`))
      .grants;
  }

  async upsertGrant(
    clientId: string,
    serviceId: string,
    input: { scopes: McpScope[]; promptNames: string[] | null; toolNames: string[] | null },
  ) {
    return (
      await this.#request<{ grant: ClientGrantRecord }>(
        `/clients/${clientId}/grants/${serviceId}`,
        { method: "PUT", body: JSON.stringify(input) },
      )
    ).grant;
  }

  async deleteGrant(clientId: string, serviceId: string) {
    await this.#request(`/clients/${clientId}/grants/${serviceId}`, { method: "DELETE" });
  }

  async listAuditEvents(filters: { outcome?: "SUCCEEDED" | "FAILED"; action?: string } = {}) {
    const query = new URLSearchParams({ limit: "100" });
    if (filters.outcome) query.set("outcome", filters.outcome);
    if (filters.action) query.set("action", filters.action);
    return (await this.#request<{ events: AuditEventRecord[] }>(`/audit?${query}`)).events;
  }
}
