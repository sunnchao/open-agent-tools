import type {
  ExecutionLimits,
  ManagedTool,
  PromptDefinition,
  RemoteServiceConfig,
} from "@open-agent-tools/mcp-contracts";

export type AdminRole = "admin" | "operator" | "auditor";
export type ServiceType = "MANAGED_MCP" | "REMOTE_MCP";
export type ServiceStatus = "DRAFT" | "ACTIVE" | "DISABLED" | "DELETED";
export type VersionStatus =
  "DRAFT" | "VALIDATING" | "BUILDING" | "READY" | "FAILED" | "PUBLISHED" | "SUPERSEDED";
export type BuildJobKind = "INSPECT" | "BUILD";
export type BuildJobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
export type UsageEventStatus = "RESERVED" | "SUCCEEDED" | "FAILED";

export interface Actor {
  id: string;
  role: AdminRole;
}

export interface McpServiceRecord {
  id: string;
  name: string;
  slug: string;
  type: ServiceType;
  status: ServiceStatus;
  currentVersionId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface McpServiceEnvironment {
  environment: Record<string, null>;
  revision: number;
}

export interface ConfiguredTool extends ManagedTool {
  id: string;
}

export interface ConfiguredPrompt extends PromptDefinition {
  id: string;
}

export interface McpServiceVersionRecord {
  id: string;
  serviceId: string;
  versionNumber: number;
  status: VersionStatus;
  runtime: { name: "nodejs"; version: "20" } | null;
  entry: string | null;
  buildCommand: "npm run build" | null;
  limits: ExecutionLimits | null;
  artifactDigest: string | null;
  artifactObjectKey: string | null;
  artifactSize: number | null;
  imageDigest: string | null;
  /** REMOTE_MCP：上游第三方 MCP Server 接入配置；MANAGED_MCP 为 null。 */
  remoteConfig: RemoteServiceConfig | null;
  tools: ConfiguredTool[];
  prompts: ConfiguredPrompt[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface PublishedVersionResult {
  service: McpServiceRecord;
  version: McpServiceVersionRecord;
}

export interface BuildJobRecord {
  id: string;
  versionId: string;
  kind: BuildJobKind;
  status: BuildJobStatus;
  stage: string;
  artifactObjectKey: string;
  artifactDigest: string;
  artifactSize: number;
  imageDigest: string | null;
  sbomObjectKey: string | null;
  errorCode: string | null;
  attempt: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface BuildJobSummary extends BuildJobRecord {
  serviceId: string;
  serviceName: string;
  versionNumber: number;
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
  status: UsageEventStatus;
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

export interface UsageEventQuery {
  limit: number;
  serviceId?: string;
  from?: string;
  to?: string;
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
  type: ServiceType;
  versionId: string;
  versionNumber: number;
  toolCount: number | null;
  promptCount: number;
  toolsUnknown: boolean;
  tools: MarketplaceTool[];
  prompts: MarketplacePrompt[];
}
