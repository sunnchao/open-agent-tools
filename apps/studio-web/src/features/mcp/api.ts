import { createMcpClient } from "@open-agent-tools/studio-client";
export { McpApiError } from "@open-agent-tools/studio-client";
import type { McpVersion, JobReference } from "@open-agent-tools/mcp-contracts/api";
export type {
  VersionStatus,
  McpScope,
  McpService,
  McpServiceEnvironment,
  McpTool,
  McpPrompt,
  McpExecutionLimits,
  RemoteTransport,
  RemoteServiceConfigPublic,
  RemoteProbeTool,
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
  SlaErrorBucket,
  ToolSlaStat,
  ServiceSlaStat,
  ToolSlaReport,
  MarketplaceTool,
  MarketplacePrompt,
  MarketplaceService,
  ClientQuotaRecord,
  UsageEventRecord,
  UsageSummary,
} from "@open-agent-tools/mcp-contracts/api";
const client = createMcpClient((path, init) => fetch(`/mcp-api${path}`, init));
export const {
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
} = client;
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
export async function uploadArtifact(
  serviceId: string,
  versionId: string,
  expectedRevision: number,
  file: File,
): Promise<{ version: McpVersion; job: JobReference }> {
  const digest = await sha256(file);
  return client.uploadArtifact(serviceId, versionId, expectedRevision, {
    sha256: digest,
    size: file.size,
    data: file,
  });
}
