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
  McpVersion,
  JobReference,
  BuildJobSummary,
  ApiClientRecord,
  ClientGrantRecord,
  AuditEventSummary,
  AuditEventRecord,
  SlaWindow,
  ToolSlaReport,
  MarketplaceService,
  ClientQuotaRecord,
  UsageEventRecord,
} from "@open-agent-tools/mcp-contracts/api";
/** Older gateways may include a display prefix; current API responses use the key ID. */
export type ApiKeyRecord = import("@open-agent-tools/mcp-contracts/api").ApiKeyRecord & {
  prefix?: string;
};
import { mcpFetch, gatewayFetch, getSettings } from "../lib/http";
const client = createMcpClient(mcpFetch);
export const {
  listServices,
  listMarketplaceServices,
  getService,
  getServiceEnvironment,
  updateServiceEnvironment,
  listVersions,
  updateVersionLimits,
  createService,
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
export interface UploadFileInput {
  name: string;
  size: number;
  sha256: string;
  contentType?: string;
  data: Blob | Uint8Array | string;
}
export function uploadArtifact(
  serviceId: string,
  versionId: string,
  expectedRevision: number,
  file: UploadFileInput,
): Promise<{ version: McpVersion; job: JobReference }> {
  return client.uploadArtifact(serviceId, versionId, expectedRevision, {
    sha256: file.sha256,
    size: file.size,
    data: file.data as BodyInit,
  });
}
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
