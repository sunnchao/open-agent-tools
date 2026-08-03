import type { ManagedTool, PromptDefinition } from "@open-agent-tools/mcp-contracts";

export type AdminRole = "admin" | "operator" | "auditor";
export type ServiceType = "MANAGED_MCP" | "REMOTE_MCP";
export type ServiceStatus = "DRAFT" | "ACTIVE" | "DISABLED" | "DELETED";
export type VersionStatus =
  "DRAFT" | "VALIDATING" | "BUILDING" | "READY" | "FAILED" | "PUBLISHED" | "SUPERSEDED";
export type BuildJobKind = "INSPECT" | "BUILD";
export type BuildJobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";

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
