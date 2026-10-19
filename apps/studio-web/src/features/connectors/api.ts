import { studioFetch } from "../../lib/client.js";

export type ConnectorType = "http" | "local-dir" | "feishu" | "yuque" | "confluence";
export type ConnectorSyncStatus = "idle" | "success" | "partial" | "error";

export interface ConnectorFilter {
  include: string[];
  exclude: string[];
  maxDocuments: number | null;
}

export interface ConnectorRecord {
  id: string;
  name: string;
  type: ConnectorType;
  baseUrl: string | null;
  filter: ConnectorFilter;
  enabled: boolean;
  credentialKeys: string[];
  hasCredential: boolean;
  lastStatus: ConnectorSyncStatus | null;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorDraft {
  id?: string;
  name: string;
  type: ConnectorType;
  baseUrl: string;
  credentials: Record<string, string>;
  filter: ConnectorFilter;
  enabled: boolean;
}

export interface ConnectorSyncFailure {
  externalId: string;
  reason: string;
}

export interface ConnectorSyncRun {
  id: string;
  connectorId: string;
  status: ConnectorSyncStatus;
  pulled: number;
  ingested: number;
  skipped: number;
  failed: number;
  failures: ConnectorSyncFailure[];
  error: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export const CONNECTOR_TYPES: ConnectorType[] = [
  "http",
  "local-dir",
  "feishu",
  "yuque",
  "confluence",
];

export const CONNECTOR_TYPE_LABELS: Record<ConnectorType, string> = {
  http: "通用 HTTP / JSON",
  "local-dir": "本地目录",
  feishu: "飞书文档",
  yuque: "语雀",
  confluence: "Confluence",
};

export interface CredentialFieldSpec {
  key: string;
  label: string;
  secret: boolean;
  placeholder: string;
}

/** 各类型需要的凭据字段(供表单渲染);值不在前端持久化。 */
export const CONNECTOR_CREDENTIAL_FIELDS: Record<ConnectorType, CredentialFieldSpec[]> = {
  http: [
    { key: "token", label: "Bearer Token", secret: true, placeholder: "可选,写入 Authorization" },
    {
      key: "headers",
      label: "额外请求头",
      secret: false,
      placeholder: '可选 JSON,如 {"X-Api-Key":"..."}',
    },
  ],
  "local-dir": [],
  feishu: [
    { key: "appId", label: "App ID", secret: false, placeholder: "cli_xxx" },
    { key: "appSecret", label: "App Secret", secret: true, placeholder: "应用密钥" },
  ],
  yuque: [
    { key: "token", label: "Access Token", secret: true, placeholder: "语雀个人令牌" },
    { key: "namespace", label: "知识库命名空间", secret: false, placeholder: "team/book" },
  ],
  confluence: [
    { key: "email", label: "登录邮箱", secret: false, placeholder: "you@company.com" },
    { key: "apiToken", label: "API Token", secret: true, placeholder: "Atlassian API Token" },
  ],
};

/** baseUrl 对各类型的含义不同,表单提示随之变化。 */
export const CONNECTOR_BASE_URL_HINTS: Record<ConnectorType, string> = {
  http: "返回文档 JSON 的接口地址",
  "local-dir": "服务端可读的目录绝对路径",
  feishu: "默认 https://open.feishu.cn,可留空",
  yuque: "默认 https://www.yuque.com,可留空",
  confluence: "站点地址,如 https://team.atlassian.net/wiki",
};

/** 多行文本 <-> 过滤规则数组的互转(每行一条)。 */
export function linesToPatterns(text: string): string[] {
  return [
    ...new Set(
      text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

export function patternsToText(patterns: string[]): string {
  return patterns.join("\n");
}

export function statusLabel(status: ConnectorSyncStatus | null): string {
  if (status === "success") return "成功";
  if (status === "partial") return "部分成功";
  if (status === "error") return "失败";
  return "未同步";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await studioFetch(path, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function fetchConnectors(): Promise<ConnectorRecord[]> {
  return request<{ connectors: ConnectorRecord[] }>("/api/admin/connectors").then(
    (body) => body.connectors,
  );
}

export function saveConnector(draft: ConnectorDraft): Promise<ConnectorRecord> {
  // 只提交填了值的凭据字段:留空表示「保持服务端已有凭据不变」。
  const credentials = Object.fromEntries(
    Object.entries(draft.credentials).filter(([, value]) => value.trim().length > 0),
  );
  const payload = {
    name: draft.name,
    type: draft.type,
    baseUrl: draft.baseUrl.trim() ? draft.baseUrl.trim() : null,
    ...(Object.keys(credentials).length > 0 ? { credentials } : {}),
    filter: draft.filter,
    enabled: draft.enabled,
  };
  return request<{ connector: ConnectorRecord }>(
    draft.id ? `/api/admin/connectors/${encodeURIComponent(draft.id)}` : "/api/admin/connectors",
    {
      method: draft.id ? "PUT" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
  ).then((body) => body.connector);
}

export function removeConnector(id: string): Promise<void> {
  return request<void>(`/api/admin/connectors/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function syncConnector(
  id: string,
): Promise<{ run: ConnectorSyncRun; connector: ConnectorRecord }> {
  return request(`/api/admin/connectors/${encodeURIComponent(id)}/sync`, { method: "POST" });
}

export function fetchConnectorRuns(id: string, limit = 10): Promise<ConnectorSyncRun[]> {
  return request<{ runs: ConnectorSyncRun[] }>(
    `/api/admin/connectors/${encodeURIComponent(id)}/runs?limit=${limit}`,
  ).then((body) => body.runs);
}
