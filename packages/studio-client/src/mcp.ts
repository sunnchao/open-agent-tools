import type {
  McpScope,
  McpService,
  McpServiceEnvironment,
  McpTool,
  McpPrompt,
  McpExecutionLimits,
  RemoteProbeResult,
  RemoteServiceConfigInput,
  McpVersion,
  JobReference,
  BuildJobSummary,
  ApiClientRecord,
  ApiKeyRecord,
  ClientGrantRecord,
  AuditEventSummary,
  AuditEventRecord,
  SlaWindow,
  ToolSlaReport,
  MarketplaceService,
  ClientQuotaRecord,
  UsageEventRecord,
  UsageSummary,
} from "@open-agent-tools/mcp-contracts/api";
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

/** Platform adapters resolve URLs and credentials for each request. */
export function createMcpClient(
  transport: (path: string, init?: RequestInit) => Promise<Response>,
) {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await transport(path, {
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
  async function listServices(): Promise<McpService[]> {
    return (await request<{ services: McpService[] }>("/services")).services;
  }

  async function listMarketplaceServices(): Promise<MarketplaceService[]> {
    return (await request<{ services: MarketplaceService[] }>("/marketplace?limit=100")).services;
  }

  async function getService(serviceId: string): Promise<McpService> {
    return (await request<{ service: McpService }>(`/services/${serviceId}`)).service;
  }

  function getServiceEnvironment(serviceId: string): Promise<McpServiceEnvironment> {
    return request(`/services/${serviceId}/environment`);
  }

  function updateServiceEnvironment(
    serviceId: string,
    expectedRevision: number,
    environment: Record<string, string | null>,
  ): Promise<McpServiceEnvironment> {
    return request(`/services/${serviceId}/environment`, {
      method: "PUT",
      body: JSON.stringify({ expectedRevision, environment }),
    });
  }

  async function listVersions(serviceId: string): Promise<McpVersion[]> {
    return (await request<{ versions: McpVersion[] }>(`/services/${serviceId}/versions`)).versions;
  }

  async function updateVersionLimits(
    serviceId: string,
    versionId: string,
    expectedRevision: number,
    limits: McpExecutionLimits,
  ): Promise<McpVersion> {
    return (
      await request<{ version: McpVersion }>(
        `/services/${serviceId}/versions/${versionId}/limits`,
        {
          method: "PUT",
          body: JSON.stringify({ expectedRevision, limits }),
        },
      )
    ).version;
  }

  async function createService(input: {
    name: string;
    slug: string;
  }): Promise<{ service: McpService; draftVersion: McpVersion }> {
    return request("/services", {
      method: "POST",
      body: JSON.stringify({ ...input, type: "MANAGED_MCP" }),
    });
  }

  async function createRemoteService(input: {
    name: string;
    slug: string;
    remote: RemoteServiceConfigInput;
  }): Promise<{ service: McpService; draftVersion: McpVersion }> {
    return request("/services", {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        slug: input.slug,
        type: "REMOTE_MCP",
        remote: input.remote,
      }),
    });
  }

  async function updateRemoteConfig(
    serviceId: string,
    versionId: string,
    expectedRevision: number,
    remote: Partial<RemoteServiceConfigInput>,
  ): Promise<McpVersion> {
    return (
      await request<{ version: McpVersion }>(
        `/services/${serviceId}/versions/${versionId}/remote-config`,
        {
          method: "PUT",
          body: JSON.stringify({ expectedRevision, remote }),
        },
      )
    ).version;
  }

  function testRemoteConnection(remote: RemoteServiceConfigInput): Promise<RemoteProbeResult> {
    return request("/remote/test-connection", {
      method: "POST",
      body: JSON.stringify({ remote }),
    });
  }

  function testSavedRemoteConnection(
    serviceId: string,
    versionId: string,
    remote?: RemoteServiceConfigInput,
  ): Promise<RemoteProbeResult> {
    return request(`/services/${serviceId}/versions/${versionId}/test-connection`, {
      method: "POST",
      body: JSON.stringify(remote ? { remote } : {}),
    });
  }

  async function updateService(
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

  async function deleteService(serviceId: string, expectedRevision: number): Promise<void> {
    await request(`/services/${serviceId}`, {
      method: "DELETE",
      body: JSON.stringify({ expectedRevision }),
    });
  }

  async function disableService(serviceId: string, expectedRevision: number): Promise<McpService> {
    return (
      await request<{ service: McpService }>(`/services/${serviceId}/disable`, {
        method: "POST",
        body: JSON.stringify({ expectedRevision }),
      })
    ).service;
  }

  async function enableService(serviceId: string, expectedRevision: number): Promise<McpService> {
    return (
      await request<{ service: McpService }>(`/services/${serviceId}/enable`, {
        method: "POST",
        body: JSON.stringify({ expectedRevision }),
      })
    ).service;
  }

  async function addTool(
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

  async function updateTool(
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

  async function deleteTool(
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

  async function addPrompt(
    serviceId: string,
    versionId: string,
    expectedRevision: number,
    prompt: Omit<McpPrompt, "id">,
  ): Promise<McpVersion> {
    return (
      await request<{ version: McpVersion }>(
        `/services/${serviceId}/versions/${versionId}/prompts`,
        {
          method: "POST",
          body: JSON.stringify({ expectedRevision, prompt }),
        },
      )
    ).version;
  }

  async function updatePrompt(
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

  async function deletePrompt(
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

  async function previewPrompt(
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

  function buildVersion(
    serviceId: string,
    versionId: string,
    expectedRevision: number,
  ): Promise<{ version: McpVersion; job: JobReference }> {
    return request(`/services/${serviceId}/versions/${versionId}/build`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision }),
    });
  }

  async function validateVersion(
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

  async function resetVersionToDraft(
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

  async function forkDraftVersion(serviceId: string, versionId: string): Promise<McpVersion> {
    return (
      await request<{ version: McpVersion }>(
        `/services/${serviceId}/versions/${versionId}/fork-draft`,
        { method: "POST", body: JSON.stringify({}) },
      )
    ).version;
  }

  function publishVersion(
    serviceId: string,
    versionId: string,
    expectedRevision: number,
  ): Promise<{ service: McpService; version: McpVersion }> {
    return request(`/services/${serviceId}/versions/${versionId}/publish`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision }),
    });
  }

  function rollbackVersion(
    serviceId: string,
    versionId: string,
    expectedRevision: number,
  ): Promise<{ service: McpService; version: McpVersion }> {
    return request(`/services/${serviceId}/versions/${versionId}/rollback`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision }),
    });
  }

  async function listBuilds(): Promise<BuildJobSummary[]> {
    return (await request<{ builds: BuildJobSummary[] }>("/builds?limit=100")).builds;
  }

  async function listClients(): Promise<ApiClientRecord[]> {
    return (await request<{ clients: ApiClientRecord[] }>("/clients")).clients;
  }

  async function createClient(name: string): Promise<ApiClientRecord> {
    return (
      await request<{ client: ApiClientRecord }>("/clients", {
        method: "POST",
        body: JSON.stringify({ name }),
      })
    ).client;
  }

  async function listApiKeys(clientId: string): Promise<ApiKeyRecord[]> {
    return (await request<{ keys: ApiKeyRecord[] }>(`/clients/${clientId}/keys`)).keys;
  }

  function createApiKey(
    clientId: string,
    expiresAt?: string | null,
  ): Promise<{ key: ApiKeyRecord; rawKey: string }> {
    return request(`/clients/${clientId}/keys`, {
      method: "POST",
      body: JSON.stringify({ expiresAt: expiresAt ?? null }),
    });
  }

  async function revokeApiKey(clientId: string, keyId: string): Promise<void> {
    await request(`/clients/${clientId}/keys/${keyId}`, { method: "DELETE" });
  }

  async function listGrants(clientId: string): Promise<ClientGrantRecord[]> {
    return (await request<{ grants: ClientGrantRecord[] }>(`/clients/${clientId}/grants`)).grants;
  }

  async function upsertGrant(
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

  async function deleteGrant(clientId: string, serviceId: string): Promise<void> {
    await request(`/clients/${clientId}/grants/${serviceId}`, { method: "DELETE" });
  }

  async function listClientQuotas(clientId: string): Promise<ClientQuotaRecord[]> {
    return (await request<{ quotas: ClientQuotaRecord[] }>(`/clients/${clientId}/quotas`)).quotas;
  }

  async function upsertClientQuota(
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

  async function listClientUsage(
    clientId: string,
    filters: { serviceId?: string; from?: string; to?: string; limit?: number } = {},
  ): Promise<{ events: UsageEventRecord[]; summary: UsageSummary }> {
    const query = new URLSearchParams({ limit: String(filters.limit ?? 100) });
    if (filters.serviceId) query.set("serviceId", filters.serviceId);
    if (filters.from) query.set("from", filters.from);
    if (filters.to) query.set("to", filters.to);
    return request(`/clients/${clientId}/usage?${query}`);
  }

  async function listAuditEvents(
    filters: { outcome?: AuditEventSummary["outcome"]; action?: string } = {},
  ): Promise<AuditEventSummary[]> {
    const query = new URLSearchParams({ limit: "100" });
    if (filters.outcome) query.set("outcome", filters.outcome);
    if (filters.action) query.set("action", filters.action);
    return (await request<{ events: AuditEventSummary[] }>(`/audit?${query}`)).events;
  }

  async function getAuditEvent(eventId: string): Promise<AuditEventRecord> {
    return (await request<{ event: AuditEventRecord }>(`/audit/${encodeURIComponent(eventId)}`))
      .event;
  }

  function buildToolSlaQuery(options: { window?: SlaWindow; serviceSlug?: string } = {}): string {
    const query = new URLSearchParams({ window: options.window ?? "24h" });
    if (options.serviceSlug) query.set("serviceSlug", options.serviceSlug);
    return query.toString();
  }

  async function getToolSla(
    options: { window?: SlaWindow; serviceSlug?: string } = {},
  ): Promise<ToolSlaReport> {
    return request<ToolSlaReport>(`/observability/tools?${buildToolSlaQuery(options)}`);
  }
  async function uploadArtifact(
    serviceId: string,
    versionId: string,
    expectedRevision: number,
    file: { sha256: string; size: number; data: BodyInit },
  ): Promise<{ version: McpVersion; job: JobReference }> {
    const requested = await request<{
      objectKey: string;
      upload: { url: string; method: "PUT"; headers: Record<string, string> };
    }>(`/services/${serviceId}/versions/${versionId}/upload-url`, {
      method: "POST",
      body: JSON.stringify({ sha256: file.sha256, size: file.size }),
    });
    const body = file.data;
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
  return {
    listServices,
    listMarketplaceServices,
    getService,
    getServiceEnvironment,
    updateServiceEnvironment,
    listVersions,
    updateVersionLimits,
    createService,
    createRemoteService,
    updateRemoteConfig,
    testRemoteConnection,
    testSavedRemoteConnection,
    updateService,
    deleteService,
    disableService,
    enableService,
    addTool,
    updateTool,
    deleteTool,
    addPrompt,
    updatePrompt,
    deletePrompt,
    previewPrompt,
    buildVersion,
    validateVersion,
    resetVersionToDraft,
    forkDraftVersion,
    publishVersion,
    rollbackVersion,
    listBuilds,
    listClients,
    createClient,
    listApiKeys,
    createApiKey,
    revokeApiKey,
    listGrants,
    upsertGrant,
    deleteGrant,
    listClientQuotas,
    upsertClientQuota,
    listClientUsage,
    listAuditEvents,
    getAuditEvent,
    buildToolSlaQuery,
    getToolSla,
    uploadArtifact,
  };
}
