import { createHash } from "node:crypto";
import {
  type Connector,
  type ConnectorConfig,
  type ConnectorDeps,
  type ConnectorDocument,
  type HttpFetchLike,
} from "./types.js";
import { firstString } from "./shared.js";

/**
 * 通用 JSON/REST 连接器。
 *
 * 约定:GET `baseUrl`,响应可以是文档数组,也可以是 `{ documents: [...] }`
 * / `{ items: [...] }` / `{ data: [...] }` 包裹。每篇文档按常见字段名做映射,
 * 缺省字段会走保守回退(见 `mapItem`)。
 */
export const httpConnector: Connector = {
  type: "http",
  async fetchDocuments(config: ConnectorConfig, deps: ConnectorDeps): Promise<ConnectorDocument[]> {
    if (!config.baseUrl) throw new Error("http connector requires baseUrl");
    const fetchImpl = requireFetch(deps);
    const response = await fetchImpl(config.baseUrl, {
      method: "GET",
      headers: authHeaders(config, "application/json"),
    });
    if (!response.ok) {
      throw new Error(`http connector request failed (${response.status})`);
    }
    const body = (await response.json()) as unknown;
    return extractItems(body).map((item, index) => mapItem(item, index));
  },
};

export function requireFetch(deps: ConnectorDeps): HttpFetchLike {
  const impl = deps.fetch ?? (typeof fetch === "function" ? fetch : undefined);
  if (!impl) throw new Error("no fetch implementation available");
  return impl;
}

/** 凭据里的 token 走 Bearer;headers 允许传一段 JSON 做额外头(可选)。 */
export function authHeaders(config: ConnectorConfig, accept: string): Record<string, string> {
  const headers: Record<string, string> = { accept };
  const token = config.credentials.token?.trim();
  if (token) headers.authorization = `Bearer ${token}`;
  const extra = config.credentials.headers?.trim();
  if (extra) {
    try {
      const parsed = JSON.parse(extra) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") headers[key] = value;
      }
    } catch {
      throw new Error("connector credentials.headers must be a JSON object");
    }
  }
  return headers;
}

function extractItems(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    for (const key of ["documents", "items", "data", "results"]) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
  }
  throw new Error("http connector response must be a JSON array or { documents: [] }");
}

export function mapItem(item: unknown, index: number): ConnectorDocument {
  if (!item || typeof item !== "object") {
    throw new Error(`document at index ${index} is not an object`);
  }
  const record = item as Record<string, unknown>;
  const title = firstString(record, ["title", "name", "subject"]) ?? `Document ${index + 1}`;
  const content = firstString(record, ["content", "body", "text", "markdown", "description"]) ?? "";
  const url = firstString(record, ["url", "link", "href"]);
  const explicitId = firstString(record, ["id", "externalId", "external_id", "key", "slug"]);
  // 稳定外部 id:优先显式 id,其次 url,最后退化为标题哈希,保证同名文档跨同步稳定。
  const externalId =
    explicitId ?? url ?? createHash("sha1").update(title).digest("hex").slice(0, 16);
  return {
    externalId,
    title,
    content,
    url,
    mimeType: firstString(record, ["mimeType", "mime_type", "mime"]) ?? "text/markdown",
    updatedAt: firstString(record, ["updatedAt", "updated_at", "modifiedAt", "modified_at"]),
  };
}
