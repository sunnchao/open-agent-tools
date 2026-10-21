import { agentFetch, parseError } from "../lib/http";

// ---- connectors ----
export type ConnectorType = "http" | "local-dir" | "feishu" | "yuque" | "confluence";
export type ConnectorSyncStatus = "idle" | "success" | "partial" | "error";
export interface ConnectorRecord {
  id: string;
  name: string;
  type: ConnectorType;
  baseUrl: string | null;
  filter: { include: string[]; exclude: string[]; maxDocuments: number | null };
  enabled: boolean;
  credentialKeys: string[];
  hasCredential: boolean;
  lastStatus: ConnectorSyncStatus | null;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface ConnectorDraft {
  id?: string;
  name: string;
  type: ConnectorType;
  baseUrl: string;
  credentials: Record<string, string>;
  filter: ConnectorRecord["filter"];
  enabled: boolean;
}
export interface ConnectorSyncRun {
  id: string;
  connectorId: string;
  status: ConnectorSyncStatus;
  pulled: number;
  ingested: number;
  skipped: number;
  failed: number;
  failures: Array<{ externalId: string; reason: string }>;
  error: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}
export const CONNECTOR_TYPES: ConnectorType[] = [
  "http",
  "local-dir",
  "feishu",
  "yuque",
  "confluence",
];
export const CONNECTOR_TYPE_LABELS: Record<ConnectorType, string> = {
  http: "通用 HTTP / JSON",
  "local-dir": "本地目录",
  feishu: "飞书文档",
  yuque: "语雀",
  confluence: "Confluence",
};
export function linesToPatterns(text: string): string[] {
  return [
    ...new Set(
      text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  ];
}
export function patternsToText(patterns: string[]): string {
  return patterns.join("\n");
}
export function statusLabel(status: ConnectorSyncStatus | null): string {
  if (status === "success") return "成功";
  if (status === "partial") return "部分成功";
  if (status === "error") return "失败";
  return "未同步";
}
async function adminRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await agentFetch(path, init);
  if (!r.ok) throw new Error(await parseError(r));
  if (r.status === 204) return undefined as T;
  return (await r.json()) as T;
}
export function fetchConnectors(): Promise<ConnectorRecord[]> {
  return adminRequest<{ connectors: ConnectorRecord[] }>("/api/admin/connectors").then(
    (b) => b.connectors,
  );
}
export function saveConnector(draft: ConnectorDraft): Promise<ConnectorRecord> {
  const credentials = Object.fromEntries(
    Object.entries(draft.credentials).filter(([, v]) => v.trim().length > 0),
  );
  const payload = {
    name: draft.name,
    type: draft.type,
    baseUrl: draft.baseUrl.trim() ? draft.baseUrl.trim() : null,
    ...(Object.keys(credentials).length > 0 ? { credentials } : {}),
    filter: draft.filter,
    enabled: draft.enabled,
  };
  return adminRequest<{ connector: ConnectorRecord }>(
    draft.id ? `/api/admin/connectors/${encodeURIComponent(draft.id)}` : "/api/admin/connectors",
    {
      method: draft.id ? "PUT" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
  ).then((b) => b.connector);
}
export function removeConnector(id: string): Promise<void> {
  return adminRequest<void>(`/api/admin/connectors/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}
export function syncConnector(
  id: string,
): Promise<{ run: ConnectorSyncRun; connector: ConnectorRecord }> {
  return adminRequest(`/api/admin/connectors/${encodeURIComponent(id)}/sync`, { method: "POST" });
}
export function fetchConnectorRuns(id: string, limit = 10): Promise<ConnectorSyncRun[]> {
  return adminRequest<{ runs: ConnectorSyncRun[] }>(
    `/api/admin/connectors/${encodeURIComponent(id)}/runs?limit=${limit}`,
  ).then((b) => b.runs);
}

// ---- reports ----
export type ReportFrequency = "daily" | "weekly";
export type ReportRunStatus = "running" | "succeeded" | "failed" | "clarifying";
export interface ReportSchedule {
  frequency: ReportFrequency;
  time: string;
  weekday?: number;
}
export interface ReportRun {
  id: string;
  reportId: string;
  workspace: string;
  status: ReportRunStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number;
  rowCount: number | null;
  truncated: boolean;
  sql: string | null;
  error: string | null;
  auditId: string | null;
  columns: string[];
  preview: Record<string, unknown>[];
  checks: Array<{ code: string; level: "info" | "warning"; message: string; column?: string }>;
}
export interface ScheduledReport {
  id: string;
  workspace: string;
  name: string;
  question: string;
  sourceId: string | null;
  schedule: ReportSchedule;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: ReportRunStatus | null;
  createdAt: string;
  updatedAt: string;
}
export interface ReportDraft {
  name: string;
  question: string;
  sourceId: string | null;
  frequency: ReportFrequency;
  time: string;
  weekday: number;
  enabled: boolean;
}
function draftPayload(d: ReportDraft): Record<string, unknown> {
  return {
    name: d.name,
    question: d.question,
    sourceId: d.sourceId,
    frequency: d.frequency,
    time: d.time,
    ...(d.frequency === "weekly" ? { weekday: d.weekday } : {}),
    enabled: d.enabled,
  };
}
export function listReports(): Promise<{ reports: ScheduledReport[] }> {
  return adminRequest("/api/admin/reports");
}
export function getReport(id: string): Promise<{ report: ScheduledReport; runs: ReportRun[] }> {
  return adminRequest(`/api/admin/reports/${encodeURIComponent(id)}`);
}
export function createReport(d: ReportDraft): Promise<{ report: ScheduledReport }> {
  return adminRequest("/api/admin/reports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(draftPayload(d)),
  });
}
export function updateReport(id: string, d: ReportDraft): Promise<{ report: ScheduledReport }> {
  return adminRequest(`/api/admin/reports/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(draftPayload(d)),
  });
}
export function deleteReport(id: string): Promise<{ ok: true }> {
  return adminRequest(`/api/admin/reports/${encodeURIComponent(id)}`, { method: "DELETE" });
}
export function runReportNow(id: string): Promise<{ run: ReportRun; report: ScheduledReport }> {
  return adminRequest(`/api/admin/reports/${encodeURIComponent(id)}/run`, { method: "POST" });
}
export function listReportRuns(id: string, limit = 20): Promise<{ runs: ReportRun[] }> {
  return adminRequest(`/api/admin/reports/${encodeURIComponent(id)}/runs?limit=${limit}`);
}

export interface SchemaSourceOption {
  id: string;
  name: string;
  connector: string;
  databaseName: string | null;
  isDefault: boolean;
}

export async function listSchemaSources(): Promise<SchemaSourceOption[]> {
  const r = await agentFetch("/api/schema-sources");
  if (!r.ok) throw new Error(await parseError(r));
  return ((await r.json()) as { sources: SchemaSourceOption[] }).sources;
}

export interface SchemaSourceMetadata {
  id: string;
  name: string;
  connector: string;
  syncStatus: string;
  isDefault: boolean;
}

export async function fetchAdminSchemaSources(): Promise<SchemaSourceMetadata[]> {
  const r = await agentFetch("/api/admin/schema-sources");
  if (!r.ok) throw new Error(await parseError(r));
  return ((await r.json()) as { sources: SchemaSourceMetadata[] }).sources;
}

// ---- providers ----
export type ProviderFormat = "openai-chat" | "openai-response" | "anthropic-message";
export const PROVIDER_FORMATS: ProviderFormat[] = [
  "openai-chat",
  "openai-response",
  "anthropic-message",
];
export const PROVIDER_FORMAT_LABELS: Record<ProviderFormat, string> = {
  "openai-chat": "OpenAI Chat",
  "openai-response": "OpenAI Response",
  "anthropic-message": "Anthropic Message",
};
export interface ProviderMetadata {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  enabled: boolean;
  isDefault: boolean;
  apiKeyMasked: string | null;
  format: ProviderFormat;
  createdAt: string;
  updatedAt: string;
}
export async function fetchProviders(options?: {
  includeDisabled?: boolean;
}): Promise<ProviderMetadata[]> {
  const r = await agentFetch(options?.includeDisabled ? "/api/admin/providers" : "/api/providers");
  if (!r.ok) throw new Error(await parseError(r));
  return ((await r.json()) as { providers: ProviderMetadata[] }).providers;
}
export async function saveProvider(input: {
  id?: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  models: string[];
  enabled: boolean;
  format?: ProviderFormat;
}): Promise<ProviderMetadata> {
  const r = await agentFetch(
    input.id ? `/api/admin/providers/${encodeURIComponent(input.id)}` : "/api/admin/providers",
    {
      method: input.id ? "PUT" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!r.ok) throw new Error(await parseError(r));
  return ((await r.json()) as { provider: ProviderMetadata }).provider;
}
export async function removeProvider(id: string): Promise<void> {
  const r = await agentFetch(`/api/admin/providers/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!r.ok) throw new Error(await parseError(r));
}
export async function setDefaultProvider(id: string): Promise<ProviderMetadata> {
  const r = await agentFetch(`/api/admin/providers/${encodeURIComponent(id)}/default`, {
    method: "PUT",
  });
  if (!r.ok) throw new Error(await parseError(r));
  return ((await r.json()) as { provider: ProviderMetadata }).provider;
}
export async function fetchProviderModels(id: string): Promise<string[]> {
  const r = await agentFetch(`/api/admin/providers/${encodeURIComponent(id)}/fetch-models`, {
    method: "POST",
  });
  if (!r.ok) throw new Error(await parseError(r));
  return ((await r.json()) as { models: string[] }).models;
}
export async function probeProviderModels(params: {
  baseUrl: string;
  apiKey?: string;
}): Promise<string[]> {
  const r = await agentFetch("/api/admin/providers/fetch-models", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!r.ok) throw new Error(await parseError(r));
  return ((await r.json()) as { models: string[] }).models;
}

// ---- IM channels ----
export type ImPlatform = "feishu" | "dingtalk";
export const IM_PLATFORMS: ImPlatform[] = ["feishu", "dingtalk"];
export const IM_PLATFORM_LABELS: Record<ImPlatform, string> = { feishu: "飞书", dingtalk: "钉钉" };
export interface ImChannelMetadata {
  id: string;
  name: string;
  platform: ImPlatform;
  appId: string;
  appSecretMasked: string | null;
  encryptKeyMasked: string | null;
  ragSources: string[];
  ragTopK: number;
  requireMention: boolean;
  enabled: boolean;
  connected: boolean;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
export interface ImStatus {
  enabled: boolean;
  connected: boolean;
  channels: ImChannelMetadata[];
}
export async function fetchImChannels(): Promise<ImChannelMetadata[]> {
  const r = await agentFetch("/api/admin/im/channels");
  if (!r.ok) throw new Error(await parseError(r));
  return ((await r.json()) as { channels: ImChannelMetadata[] }).channels;
}
export async function saveImChannel(input: {
  id?: string;
  name: string;
  platform: ImPlatform;
  appId: string;
  appSecret?: string;
  encryptKey?: string;
  ragSources: string[];
  ragTopK: number;
  requireMention: boolean;
  enabled: boolean;
}): Promise<ImChannelMetadata> {
  const r = await agentFetch(
    input.id ? `/api/admin/im/channels/${encodeURIComponent(input.id)}` : "/api/admin/im/channels",
    {
      method: input.id ? "PUT" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!r.ok) throw new Error(await parseError(r));
  return ((await r.json()) as { channel: ImChannelMetadata }).channel;
}
export async function removeImChannel(id: string): Promise<void> {
  const r = await agentFetch(`/api/admin/im/channels/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!r.ok) throw new Error(await parseError(r));
}
export async function restartImChannel(id: string): Promise<ImStatus> {
  const r = await agentFetch(`/api/admin/im/channels/${encodeURIComponent(id)}/restart`, {
    method: "POST",
  });
  if (!r.ok) throw new Error(await parseError(r));
  return (await r.json()) as ImStatus;
}
export async function fetchImStatus(): Promise<ImStatus> {
  const r = await agentFetch("/api/im/status");
  if (!r.ok) throw new Error(await parseError(r));
  return (await r.json()) as ImStatus;
}

// ---- resources ----
export interface ResourceCatalog {
  mcp: {
    configured: boolean;
    services: Array<{
      serviceSlug: string;
      serviceStatus: string;
      versionStatus: string;
      tools: Array<{
        serviceSlug: string;
        name: string;
        description?: string;
        inputSchema: Record<string, unknown>;
      }>;
    }>;
    error?: string;
  };
  rag: { sources: Array<{ source: string; chunks: number }>; error?: string };
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  let r: Response;
  try {
    r = await agentFetch("/api/resources", { signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("资源目录加载超时，请检查 RAG / MCP 服务是否已启动");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!r.ok) throw new Error(await parseError(r));
  return (await r.json()) as ResourceCatalog;
}

// ---- branding ----
export interface BrandingConfig {
  productName: string;
  shortName: string;
  markText: string;
  logoUrl: string | null;
  primaryColor: string;
  accentColor: string;
  supportUrl: string | null;
  footerText: string;
  partnerCode: string | null;
  hideVendorBrand: boolean;
}
export const DEFAULT_BRANDING: BrandingConfig = {
  productName: "Open Agent Tools",
  shortName: "Open Agent",
  markText: "OA",
  logoUrl: null,
  primaryColor: "#8fb22e",
  accentColor: "#3d7dcc",
  supportUrl: null,
  footerText: "",
  partnerCode: null,
  hideVendorBrand: false,
};
export async function fetchPublicBranding(): Promise<BrandingConfig> {
  const r = await agentFetch("/api/branding");
  if (!r.ok) throw new Error(await parseError(r));
  return ((await r.json()) as { branding: BrandingConfig }).branding;
}
export async function fetchBranding(): Promise<BrandingConfig> {
  const r = await agentFetch("/api/admin/branding");
  if (!r.ok) throw new Error(await parseError(r));
  return ((await r.json()) as { branding: BrandingConfig }).branding;
}
export async function saveBranding(input: BrandingConfig): Promise<BrandingConfig> {
  const r = await agentFetch("/api/admin/branding", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new Error(await parseError(r));
  return ((await r.json()) as { branding: BrandingConfig }).branding;
}
export async function resetBranding(): Promise<BrandingConfig> {
  const r = await agentFetch("/api/admin/branding", { method: "DELETE" });
  if (!r.ok) throw new Error(await parseError(r));
  return ((await r.json()) as { branding: BrandingConfig }).branding;
}

// ---- mcp gateway config / workspaces / published apps ----
export interface McpGatewayConfig {
  gatewayUrl: string;
  apiKeyMasked: string | null;
  source: "database" | "environment" | "none";
  configured: boolean;
  updatedAt: string | null;
}
export async function fetchMcpGatewayConfig(): Promise<McpGatewayConfig> {
  const r = await agentFetch("/api/admin/mcp-gateway");
  if (!r.ok) throw new Error(await parseError(r));
  return ((await r.json()) as { config: McpGatewayConfig }).config;
}
export async function saveMcpGatewayConfig(input: {
  gatewayUrl: string;
  apiKey?: string;
}): Promise<McpGatewayConfig> {
  const r = await agentFetch("/api/admin/mcp-gateway", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new Error(await parseError(r));
  return ((await r.json()) as { config: McpGatewayConfig }).config;
}
export async function clearMcpGatewayConfig(): Promise<McpGatewayConfig> {
  const r = await agentFetch("/api/admin/mcp-gateway", { method: "DELETE" });
  if (!r.ok) throw new Error(await parseError(r));
  return ((await r.json()) as { config: McpGatewayConfig }).config;
}
export interface Workspace {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}
export async function fetchWorkspaces(): Promise<Workspace[]> {
  const r = await agentFetch("/api/admin/workspaces");
  if (!r.ok) throw new Error(await parseError(r));
  return ((await r.json()) as { workspaces: Workspace[] }).workspaces;
}
export async function createWorkspace(input: {
  name: string;
  description?: string;
}): Promise<Workspace> {
  const r = await agentFetch("/api/admin/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new Error(await parseError(r));
  return ((await r.json()) as { workspace: Workspace }).workspace;
}
export interface UsageSummary {
  workspaceId: string;
  from: number;
  to: number;
  totals: {
    events: number;
    chatTurns: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    chatDurationMs: number;
    toolDurationMs: number;
  };
  byModel: Array<{ model: string; chatTurns: number; inputTokens: number; outputTokens: number }>;
  byTool: Array<{ toolKind: string; toolName: string; calls: number; errors: number }>;
  daily: Array<{ date: string; chatTurns: number; toolCalls: number; totalTokens: number }>;
}
export async function fetchUsage(options?: {
  days?: number;
  all?: boolean;
}): Promise<UsageSummary> {
  const params = new URLSearchParams({ days: String(options?.days ?? 30) });
  if (options?.all) params.set("workspaceId", "*");
  const r = await agentFetch(`/api/admin/usage?${params}`);
  if (!r.ok) throw new Error(await parseError(r));
  return ((await r.json()) as { usage: UsageSummary }).usage;
}
export interface PublishedAppRecord {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: string;
  welcome: string;
  suggestions: Array<{ title: string; prompt: string }>;
  resources: {
    rag?: { sources?: string[]; topK?: number };
    mcpTools?: Array<{ serviceSlug: string; toolName: string }>;
    sqlSources?: string[];
  };
  allowedGroups: string[];
  providerId: string | null;
  model: string | null;
  status: "ACTIVE" | "ARCHIVED";
  accessMode: "public" | "token";
  accessTokenHint: string | null;
  rateLimitPerMinute: number;
  dailyTokenBudget: number;
  createdAt: string;
  updatedAt: string;
}
export async function fetchPublishedApps(): Promise<PublishedAppRecord[]> {
  const r = await agentFetch("/api/admin/published-apps");
  if (!r.ok) throw new Error(await parseError(r));
  return ((await r.json()) as { apps: PublishedAppRecord[] }).apps;
}
export async function createPublishedApp(input: {
  name: string;
  slug?: string;
  description?: string;
  welcome?: string;
  suggestions?: Array<{ title: string; prompt: string }>;
  resources?: PublishedAppRecord["resources"];
  allowedGroups?: string[];
}): Promise<PublishedAppRecord> {
  const r = await agentFetch("/api/admin/published-apps", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new Error(await parseError(r));
  return ((await r.json()) as { app: PublishedAppRecord }).app;
}
export async function updatePublishedApp(
  id: string,
  patch: Partial<
    Pick<
      PublishedAppRecord,
      | "name"
      | "description"
      | "welcome"
      | "status"
      | "resources"
      | "allowedGroups"
      | "accessMode"
      | "rateLimitPerMinute"
      | "dailyTokenBudget"
    >
  >,
): Promise<PublishedAppRecord> {
  const r = await agentFetch(`/api/admin/published-apps/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(await parseError(r));
  return ((await r.json()) as { app: PublishedAppRecord }).app;
}
export async function rotateAccessToken(
  id: string,
  enable: boolean,
): Promise<{ app: PublishedAppRecord; token: string | null }> {
  const r = await agentFetch(`/api/admin/published-apps/${encodeURIComponent(id)}/access-token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enable }),
  });
  if (!r.ok) throw new Error(await parseError(r));
  return (await r.json()) as { app: PublishedAppRecord; token: string | null };
}
export async function deletePublishedApp(id: string): Promise<void> {
  const r = await agentFetch(`/api/admin/published-apps/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!r.ok && r.status !== 404) throw new Error(await parseError(r));
}

// ---- published-app identity（与 Web adminApi.fetchPublishedAppIdentity 同接口） ----
export interface PublishedAppIdentity {
  enabled: boolean;
  keyId: string | null;
  issuer: string;
  audience: string;
  identityMode: "optional" | "required" | "required_for_groups";
  assertionHeader: "X-Viewer-Assertion";
}
export async function fetchPublishedAppIdentity(): Promise<PublishedAppIdentity> {
  const r = await agentFetch("/api/admin/published-apps/identity");
  if (!r.ok) throw new Error(await parseError(r));
  return ((await r.json()) as { identity: PublishedAppIdentity }).identity;
}

// ---- enterprise identity status（与 Web SettingsWorkspace.fetchIdentityStatus 同接口） ----
export interface IdentityStatus {
  configError?: string | null;
  enabled: boolean;
  provider: "oidc" | "deployment-token" | "none";
  mode: "oidc" | "deployment-token" | "open";
  issuer: string | null;
  audience: string | null;
  groupsClaim: string;
  rolesClaim: string;
  adminRoles: string[];
  ldap: {
    enabled: boolean;
    mode: "ldap_trusted_gateway";
    gatewayConfigured: boolean;
    passwordBinding: false;
    assertionConfigured: boolean;
    assertionKeyId: string | null;
    assertionIssuer: string | null;
    assertionAudience: string | null;
    identityMode: "optional" | "required" | "required_for_groups";
    readiness: "not_configured" | "assertion_missing" | "invalid_config" | "ready";
    configError: string | null;
    summary: string;
  };
  deploymentTokenFallback: boolean;
}
export const IDENTITY_PROVIDER_LABELS: Record<IdentityStatus["provider"], string> = {
  oidc: "OIDC",
  "deployment-token": "部署 Token",
  none: "未启用",
};
export const LDAP_READINESS_LABELS: Record<IdentityStatus["ldap"]["readiness"], string> = {
  not_configured: "未配置网关",
  assertion_missing: "断言配置不完整",
  invalid_config: "网关配置无效",
  ready: "网关链路就绪",
};
export async function fetchIdentityStatus(): Promise<IdentityStatus> {
  const r = await agentFetch("/api/admin/identity/status");
  if (!r.ok) throw new Error(await parseError(r));
  return ((await r.json()) as { identity: IdentityStatus }).identity;
}
