const TOKEN_KEY = "open-agent-tools.studio-api-token";
const WORKSPACE_KEY = "open-agent-tools.workspace-id";
const WORKSPACE_HEADER = "x-workspace-id";

/** 直接探测 localStorage：浏览器与测试环境（globalThis 注入）都适用，无需依赖 window。 */
function storage(): Storage | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

function readSetting(key: string): string {
  return storage()?.getItem(key)?.trim() ?? "";
}

function writeSetting(key: string, value: string): void {
  const target = storage();
  if (!target) return;
  const trimmed = value.trim();
  if (trimmed) target.setItem(key, trimmed);
  else target.removeItem(key);
}

/**
 * Studio 主服务访问 Token 的前端存取位置。
 *
 * - 构建时可通过 `VITE_STUDIO_API_TOKEN` 预置；
 * - 运行时可在设置页输入并保留在 localStorage；
 * - 部署 token 未配置时返回空字符串，保持本地开发体验。
 */
export function getStudioApiToken(): string {
  const stored = readSetting(TOKEN_KEY);
  if (stored) return stored;
  return import.meta.env.VITE_STUDIO_API_TOKEN?.trim() ?? "";
}

export function setStudioApiToken(token: string): void {
  writeSetting(TOKEN_KEY, token);
}

/**
 * 当前 workspace 归属。缺省为空 → 后端回落到默认空间，保持单空间部署的原有行为。
 */
export function getWorkspaceId(): string {
  return readSetting(WORKSPACE_KEY);
}

export function setWorkspaceId(workspaceId: string): void {
  writeSetting(WORKSPACE_KEY, workspaceId);
}

/**
 * 主服务 `/api/*` 的统一请求封装：自动携带部署 token 与当前 workspace。
 * MCP（`/mcp-api/*`）由控制面单独鉴权；RAG 管理接口走 `/api/admin/rag/*`，复用本封装。
 */
export async function studioFetch(input: string, init?: RequestInit): Promise<Response> {
  const targetsStudioApi = input.startsWith("/api/");
  const token = targetsStudioApi ? getStudioApiToken() : "";
  const workspaceId = targetsStudioApi ? getWorkspaceId() : "";
  // 无 token 且无 workspace（本地默认）时原样透传，调用形状与 fetch(input, init) 一致。
  if (!token && !workspaceId) return fetch(input, init);
  const headers = new Headers(init?.headers ?? {});
  if (token && !headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
  if (workspaceId && !headers.has(WORKSPACE_HEADER)) headers.set(WORKSPACE_HEADER, workspaceId);
  return fetch(input, { ...init, headers });
}
