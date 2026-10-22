import { defaultConfig, joinUrl, TOKEN_KEY, WORKSPACE_KEY } from "./config";
import { storageGet } from "./storage";

let tokenCache: string | null = null;
let workspaceCache: string | null = null;
let agentCache: string | null = null;
let mcpCache: string | null = null;
let gatewayCache: string | null = null;

export function setAuthMemory(input: {
  token?: string;
  workspaceId?: string;
  agentUrl?: string;
  mcpUrl?: string;
  gatewayUrl?: string;
}): void {
  if (input.token !== undefined) tokenCache = input.token;
  if (input.workspaceId !== undefined) workspaceCache = input.workspaceId;
  if (input.agentUrl !== undefined) agentCache = input.agentUrl;
  if (input.mcpUrl !== undefined) mcpCache = input.mcpUrl;
  if (input.gatewayUrl !== undefined) gatewayCache = input.gatewayUrl;
}
export function __resetAuth(): void {
  tokenCache = null;
  workspaceCache = null;
  agentCache = null;
  mcpCache = null;
  gatewayCache = null;
}

export async function getSettings(): Promise<{
  token: string;
  workspaceId: string;
  agentUrl: string;
  mcpUrl: string;
  gatewayUrl: string;
}> {
  const d = defaultConfig();
  const token = tokenCache ?? (await storageGet(TOKEN_KEY).catch(() => null)) ?? d.apiToken;
  const workspaceId =
    workspaceCache ?? (await storageGet(WORKSPACE_KEY).catch(() => null)) ?? d.workspaceId;
  return {
    token: (token ?? "").trim(),
    workspaceId: (workspaceId ?? "").trim(),
    agentUrl: (agentCache ?? d.agentUrl).replace(/\/+$/, ""),
    mcpUrl: (mcpCache ?? d.mcpUrl).replace(/\/+$/, ""),
    gatewayUrl: (gatewayCache ?? d.mcpGatewayUrl).replace(/\/+$/, ""),
  };
}

function withAuthHeaders(headers: Headers, token: string, workspaceId: string): void {
  if (token && !headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
  if (workspaceId && !headers.has("x-workspace-id")) headers.set("x-workspace-id", workspaceId);
}

/** Agent Server 请求（对应 Web 的 /api/* 与 /v1/*）。自动携带 token/workspace。 */
export async function agentFetch(path: string, init?: RequestInit): Promise<Response> {
  const s = await getSettings();
  const headers = new Headers(init?.headers ?? {});
  withAuthHeaders(headers, s.token, s.workspaceId);
  return fetch(joinUrl(s.agentUrl, path), { ...init, headers });
}

/** 知识库与图谱统一经 Agent Server 转发，复用 token 和工作区配置。 */
export async function ragRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await agentFetch(`/api/admin/rag${path}`, init);
  if (!response.ok) {
    throw new Error((await response.text()) || `RAG request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

/** Control Plane 管理请求（对应 Web 的 /mcp-api/*）。 */
export async function mcpFetch(path: string, init?: RequestInit): Promise<Response> {
  const s = await getSettings();
  const headers = new Headers(init?.headers ?? {});
  if (init?.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  for (const [k, v] of headers.entries()) headers.set(k, v);
  const { mcpPath } = await import("./config");
  return fetch(mcpPath(s.mcpUrl, path), { ...init, headers });
}

/** Gateway 直调（MCP JSON-RPC over Streamable HTTP，RN 用纯 fetch 实现，不依赖 SDK/GET 探测）。 */
export async function gatewayFetch(serviceSlug: string, init?: RequestInit): Promise<Response> {
  const s = await getSettings();
  return fetch(joinUrl(s.gatewayUrl, `/mcp/services/${encodeURIComponent(serviceSlug)}`), init);
}

export async function parseError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string | { message?: string } };
    if (typeof body.error === "string") return body.error;
    if (body.error?.message) return body.error.message;
  } catch {
    /* ignore */
  }
  return `HTTP ${res.status}`;
}
