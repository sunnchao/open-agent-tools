export type ImPlatform = "feishu" | "dingtalk";

export const IM_PLATFORMS: ImPlatform[] = ["feishu", "dingtalk"];

export const IM_PLATFORM_LABELS: Record<ImPlatform, string> = {
  feishu: "飞书",
  dingtalk: "钉钉",
};

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

async function parseError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `HTTP ${response.status}`;
}

export async function fetchImChannels(): Promise<ImChannelMetadata[]> {
  const response = await fetch("/api/admin/im/channels");
  if (!response.ok) throw new Error(await parseError(response));
  const body = (await response.json()) as { channels: ImChannelMetadata[] };
  return body.channels;
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
  const response = await fetch(
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
  const response = await fetch(`/api/admin/im/channels/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!response.ok) throw new Error(await parseError(response));
}

export async function restartImChannel(id: string): Promise<ImStatus> {
  const response = await fetch(`/api/admin/im/channels/${encodeURIComponent(id)}/restart`, {
    method: "POST",
  });
  if (!response.ok) throw new Error(await parseError(response));
  const body = (await response.json()) as ImStatus;
  return body;
}

export async function fetchImStatus(): Promise<ImStatus> {
  const response = await fetch("/api/im/status");
  if (!response.ok) throw new Error(await parseError(response));
  return (await response.json()) as ImStatus;
}
