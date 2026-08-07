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

async function parseError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `HTTP ${response.status}`;
}

export async function fetchProviders(options?: {
  includeDisabled?: boolean;
}): Promise<ProviderMetadata[]> {
  const response = await fetch(
    options?.includeDisabled ? "/api/admin/providers" : "/api/providers",
  );
  if (!response.ok) throw new Error(await parseError(response));
  const body = (await response.json()) as { providers: ProviderMetadata[] };
  return body.providers;
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
  const response = await fetch(
    input.id ? `/api/admin/providers/${encodeURIComponent(input.id)}` : "/api/admin/providers",
    {
      method: input.id ? "PUT" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!response.ok) throw new Error(await parseError(response));
  const body = (await response.json()) as { provider: ProviderMetadata };
  return body.provider;
}

export async function removeProvider(id: string): Promise<void> {
  const response = await fetch(`/api/admin/providers/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!response.ok) throw new Error(await parseError(response));
}

export async function setDefaultProvider(id: string): Promise<ProviderMetadata> {
  const response = await fetch(`/api/admin/providers/${encodeURIComponent(id)}/default`, {
    method: "PUT",
  });
  if (!response.ok) throw new Error(await parseError(response));
  const body = (await response.json()) as { provider: ProviderMetadata };
  return body.provider;
}

export async function fetchProviderModels(id: string): Promise<string[]> {
  const response = await fetch(`/api/admin/providers/${encodeURIComponent(id)}/fetch-models`, {
    method: "POST",
  });
  if (!response.ok) throw new Error(await parseError(response));
  const body = (await response.json()) as { models: string[] };
  return body.models;
}

/** 新建 Provider 时按参数探测模型列表（无需先入库）。 */
export async function probeProviderModels(params: {
  baseUrl: string;
  apiKey?: string;
}): Promise<string[]> {
  const response = await fetch("/api/admin/providers/fetch-models", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!response.ok) throw new Error(await parseError(response));
  const body = (await response.json()) as { models: string[] };
  return body.models;
}
