import { studioFetch } from "../../lib/client.js";
import { parseHttpError as parseError } from "@open-agent-tools/studio-client";
export type ImPlatform = "feishu" | "dingtalk";

export const IM_PLATFORMS: ImPlatform[] = ["feishu", "dingtalk"];

export const IM_PLATFORM_LABELS: Record<ImPlatform, string> = {
  feishu: "飞书",
  dingtalk: "钉钉",
};

export interface ImMcpToolBinding {
  serviceSlug: string;
  toolName: string;
}

/** MCP 工具绑定在表单下拉框里的复合键分隔符。 */
export const MCP_TOOL_KEY_SEPARATOR = "::";

/** 把工具绑定编码成表单可选值。 */
export function mcpToolKey(binding: ImMcpToolBinding): string {
  return `${binding.serviceSlug}${MCP_TOOL_KEY_SEPARATOR}${binding.toolName}`;
}

/** 解析表单可选值；格式非法返回 null。 */
export function parseMcpToolKey(value: string): ImMcpToolBinding | null {
  const index = value.indexOf(MCP_TOOL_KEY_SEPARATOR);
  if (index <= 0) return null;
  const serviceSlug = value.slice(0, index);
  const toolName = value.slice(index + MCP_TOOL_KEY_SEPARATOR.length);
  if (!serviceSlug || !toolName) return null;
  return { serviceSlug, toolName };
}

export interface ImChannelMetadata {
  id: string;
  name: string;
  platform: ImPlatform;
  appId: string;
  appSecretMasked: string | null;
  encryptKeyMasked: string | null;
  ragSources: string[];
  sqlSources: string[];
  mcpTools: ImMcpToolBinding[];
  ragTopK: number;
  requireMention: boolean;
  enabled: boolean;
  connected: boolean;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export type ImSqlSourceConnector = "mysql" | "postgresql";

export interface ImSqlSourceOption {
  id: string;
  name: string;
  connector: ImSqlSourceConnector;
  isDefault: boolean;
}

export interface ImStatus {
  enabled: boolean;
  connected: boolean;
  channels: ImChannelMetadata[];
}

export type ImExternalUserIdType =
  "feishu_open_id" | "dingtalk_staff_id" | "dingtalk_sender_id" | "dingtalk_user_id";

export type ImAccountBindingStatus = "unbound" | "valid" | "invalid";
export type ImAccountChannelState = "all" | "existing" | "deleted";

export interface ImChannelAccount {
  id: string;
  workspaceId: string;
  channelId: string;
  channelName: string;
  platform: ImPlatform;
  externalUserId: string;
  externalUserIdType: ImExternalUserIdType | null;
  externalName: string | null;
  displayName: string | null;
  remark: string | null;
  providerId: string | null;
  providerName: string | null;
  model: string | null;
  bindingStatus: ImAccountBindingStatus;
  firstInteractedAt: number;
  lastInteractedAt: number;
  lastConversationId: string | null;
  lastChatType: "p2p" | "group" | null;
  channelDeleted: boolean;
  channelDeletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImAccountListFilters {
  channelId?: string;
  platform?: ImPlatform;
  keyword?: string;
  channelState?: ImAccountChannelState;
  limit?: number;
  offset?: number;
}

export interface ImAccountListResult {
  items: ImChannelAccount[];
  total: number;
  limit: number;
  offset: number;
}

export interface ImAccountUpdateInput {
  displayName?: string | null;
  remark?: string | null;
  providerId?: string | null;
  model?: string | null;
}

export async function fetchImChannels(): Promise<ImChannelMetadata[]> {
  const response = await studioFetch("/api/admin/im/channels");
  if (!response.ok) throw new Error(await parseError(response));
  const body = (await response.json()) as { channels: ImChannelMetadata[] };
  return body.channels;
}

export async function fetchImSqlSourceOptions(): Promise<ImSqlSourceOption[]> {
  const response = await studioFetch("/api/schema-sources");
  if (!response.ok) throw new Error(await parseError(response));
  const body = (await response.json()) as {
    sources?: Array<{
      id: string;
      name: string;
      connector: ImSqlSourceConnector;
      isDefault?: boolean;
    }>;
  };
  return (body.sources ?? []).map((source) => ({
    id: source.id,
    name: source.name,
    connector: source.connector,
    isDefault: Boolean(source.isDefault),
  }));
}

export async function saveImChannel(input: {
  id?: string;
  name: string;
  platform: ImPlatform;
  appId: string;
  appSecret?: string;
  encryptKey?: string;
  ragSources: string[];
  sqlSources: string[];
  mcpTools: ImMcpToolBinding[];
  ragTopK: number;
  requireMention: boolean;
  enabled: boolean;
}): Promise<ImChannelMetadata> {
  const response = await studioFetch(
    input.id ? `/api/admin/im/channels/${encodeURIComponent(input.id)}` : "/api/admin/im/channels",
    {
      method: input.id ? "PUT" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!response.ok) throw new Error(await parseError(response));
  const body = (await response.json()) as { channel: ImChannelMetadata };
  return body.channel;
}

export async function removeImChannel(id: string): Promise<void> {
  const response = await studioFetch(`/api/admin/im/channels/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!response.ok) throw new Error(await parseError(response));
}

export async function restartImChannel(id: string): Promise<ImStatus> {
  const response = await studioFetch(`/api/admin/im/channels/${encodeURIComponent(id)}/restart`, {
    method: "POST",
  });
  if (!response.ok) throw new Error(await parseError(response));
  const body = (await response.json()) as ImStatus;
  return body;
}

export async function fetchImAccounts(
  filters: ImAccountListFilters = {},
): Promise<ImAccountListResult> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const query = params.toString();
  const response = await studioFetch(`/api/admin/im/accounts${query ? `?${query}` : ""}`);
  if (!response.ok) throw new Error(await parseError(response));
  return (await response.json()) as ImAccountListResult;
}

export async function updateImAccount(
  id: string,
  input: ImAccountUpdateInput,
): Promise<ImChannelAccount> {
  const response = await studioFetch(`/api/admin/im/accounts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await parseError(response));
  const body = (await response.json()) as { account: ImChannelAccount };
  return body.account;
}

export async function fetchImStatus(): Promise<ImStatus> {
  const response = await studioFetch("/api/im/status");
  if (!response.ok) throw new Error(await parseError(response));
  return (await response.json()) as ImStatus;
}
