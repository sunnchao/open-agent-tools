import type { RemoteTransport, RemoteServiceConfigPublic } from "./remote.js";
export type { RemoteTransport, RemoteServiceConfigPublic } from "./remote.js";
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
  messages: Array<{
    role: "user" | "assistant";
    content: { type: "text"; text: string };
  }>;
}

export interface McpExecutionLimits {
  timeoutMs: number;
  memoryMb: number;
  cpuMillis: number;
  network: "none" | "bridge";
}

export interface RemoteProbeTool {
  name: string;
  description?: string;
}

export interface RemoteProbeResult {
  transport: RemoteTransport;
  url: string;
  timeoutMs: number;
  latencyMs: number;
  toolCount: number;
  tools: RemoteProbeTool[];
}

export interface RemoteServiceConfigInput {
  transport: RemoteTransport;
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** 新建时传入原文；更新时传 null/省略=保留原文，空字符串=清除。 */
  token?: string | null;
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
  /** REMOTE_MCP 版本的上游配置（token 已脱敏）；MANAGED_MCP 为 null。 */
  remoteConfig: RemoteServiceConfigPublic | null;
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

export interface SlaErrorBucket {
  code: string;
  message: string;
  count: number;
}

export interface ToolSlaStat {
  toolName: string;
  calls: number;
  succeeded: number;
  failed: number;
  successRate: number;
  p50DurationMs: number;
  p95DurationMs: number;
  maxDurationMs: number;
  errors: SlaErrorBucket[];
  lastFailure: {
    code: string;
    message: string;
    statusCode: number;
    createdAt: string;
  } | null;
}

export interface ServiceSlaStat {
  serviceSlug: string;
  calls: number;
  succeeded: number;
  failed: number;
  successRate: number;
  p95DurationMs: number;
  tools: ToolSlaStat[];
}

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
  services: ServiceSlaStat[];
}

export interface MarketplaceTool {
  name: string;
  description?: string;
}

export interface MarketplacePrompt {
  name: string;
  title?: string;
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
  tools: MarketplaceTool[];
  prompts: MarketplacePrompt[];
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
  createdAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface UsageSummary {
  total: number;
  reserved: number;
  succeeded: number;
  failed: number;
}
