import {
  type Connector,
  type ConnectorConfig,
  type ConnectorDeps,
  type ConnectorDocument,
  type HttpFetchLike,
} from "./types.js";
import { requireFetch } from "./httpConnector.js";
import { asRecord, firstString } from "./shared.js";

/**
 * 飞书 / 语雀 / Confluence 的桩实现。
 *
 * 三者都「接口已定型、真实调用走注入的 fetch」:URL 组装、鉴权方式、
 * 响应到 `ConnectorDocument` 的映射都是真实可用的,只有上游字段做了容错,
 * 因此单测用 stub fetch 就能离线跑通端到端同步。
 */

const FEISHU_BASE = "https://open.feishu.cn";
const YUQUE_BASE = "https://www.yuque.com";

async function readJson(
  fetchImpl: HttpFetchLike,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  const response = await fetchImpl(url, init);
  if (!response.ok) {
    throw new Error(`connector request failed (${response.status}) ${url}`);
  }
  return (await response.json()) as unknown;
}

/** 拉起一个数组字段:兼容 `{ items }` / `{ data: { items } }` / `{ results }` 等常见包裹。 */
function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  for (const key of ["items", "results", "documents", "data", "list"]) {
    const candidate = record[key];
    if (Array.isArray(candidate)) return candidate;
    const nested = asRecord(candidate);
    if (Array.isArray(nested.items)) return nested.items as unknown[];
    if (Array.isArray(nested.list)) return nested.list as unknown[];
  }
  return [];
}

// ── 飞书文档(open-apis/docx/v1) ──

export const feishuConnector: Connector = {
  type: "feishu",
  async fetchDocuments(config: ConnectorConfig, deps: ConnectorDeps): Promise<ConnectorDocument[]> {
    const fetchImpl = requireFetch(deps);
    const base = (config.baseUrl ?? FEISHU_BASE).replace(/\/$/, "");
    const appId = config.credentials.appId?.trim();
    const appSecret = config.credentials.appSecret?.trim();
    if (!appId || !appSecret) {
      throw new Error("feishu connector requires credentials.appId and credentials.appSecret");
    }
    // 1) 内部应用换取 tenant_access_token(飞书官方入口)。
    const tokenBody = asRecord(
      await readJson(fetchImpl, `${base}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      }),
    );
    const token =
      firstString(tokenBody, ["tenant_access_token", "app_access_token"]) ??
      firstString(asRecord(tokenBody.data), ["tenant_access_token"]);
    if (!token) throw new Error("feishu connector: tenant_access_token missing in response");
    // 2) 列出云文档。真实分页/正文块拉取留待后续接入,这里先落 title + 正文摘要。
    const listBody = await readJson(
      fetchImpl,
      `${base}/open-apis/docx/v1/documents?page_size=200`,
      { method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" } },
    );
    return asArray(listBody).map(mapFeishuDocument);
  },
};

export function mapFeishuDocument(item: unknown): ConnectorDocument {
  const record = asRecord(item);
  const externalId =
    firstString(record, ["document_id", "documentId", "token", "obj_token"]) ??
    firstString(record, ["url"]) ??
    "";
  if (!externalId) throw new Error("feishu document missing document_id");
  return {
    externalId,
    title: firstString(record, ["title", "name"]) ?? externalId,
    content: firstString(record, ["content", "text", "markdown"]) ?? "",
    url: firstString(record, ["url"]),
    mimeType: "text/markdown",
    updatedAt: firstString(record, ["updatedAt", "update_time", "updated_at"]),
  };
}

// ── 语雀知识库(api/v2/repos/:namespace/docs) ──

export const yuqueConnector: Connector = {
  type: "yuque",
  async fetchDocuments(config: ConnectorConfig, deps: ConnectorDeps): Promise<ConnectorDocument[]> {
    const fetchImpl = requireFetch(deps);
    const base = (config.baseUrl ?? YUQUE_BASE).replace(/\/$/, "");
    const token = config.credentials.token?.trim();
    if (!token) throw new Error("yuque connector requires credentials.token");
    const namespace = config.credentials.namespace?.trim() || config.credentials.repo?.trim();
    if (!namespace) {
      throw new Error("yuque connector requires credentials.namespace (e.g. team/book)");
    }
    const body = await readJson(fetchImpl, `${base}/api/v2/repos/${namespace}/docs`, {
      method: "GET",
      headers: { "X-Auth-Token": token, accept: "application/json" },
    });
    return asArray(body).map(mapYuqueDocument);
  },
};

export function mapYuqueDocument(item: unknown): ConnectorDocument {
  const record = asRecord(item);
  const externalId =
    firstString(record, ["slug", "id"]) ??
    (record.id !== undefined ? String(record.id) : null) ??
    "";
  if (!externalId) throw new Error("yuque document missing slug/id");
  return {
    externalId,
    title: firstString(record, ["title", "name"]) ?? externalId,
    content: firstString(record, ["body", "body_html", "description"]) ?? "",
    url: firstString(record, ["url", "slug"]),
    mimeType: "text/markdown",
    updatedAt: firstString(record, ["updated_at", "updatedAt"]),
  };
}

// ── Confluence(rest/api/content) ──

export const confluenceConnector: Connector = {
  type: "confluence",
  async fetchDocuments(config: ConnectorConfig, deps: ConnectorDeps): Promise<ConnectorDocument[]> {
    const fetchImpl = requireFetch(deps);
    if (!config.baseUrl) throw new Error("confluence connector requires baseUrl");
    const base = config.baseUrl.replace(/\/$/, "");
    const email = config.credentials.email?.trim();
    const apiToken = config.credentials.apiToken?.trim() ?? config.credentials.token?.trim();
    if (!email || !apiToken) {
      throw new Error("confluence connector requires credentials.email and credentials.apiToken");
    }
    const authorization = `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;
    const body = await readJson(
      fetchImpl,
      `${base}/rest/api/content?limit=200&expand=body.storage`,
      { method: "GET", headers: { authorization, accept: "application/json" } },
    );
    return asArray(body).map(mapConfluenceDocument);
  },
};

export function mapConfluenceDocument(item: unknown): ConnectorDocument {
  const record = asRecord(item);
  const idValue = record.id;
  const externalId =
    firstString(record, ["id"]) ?? (idValue !== undefined ? String(idValue) : null) ?? "";
  if (!externalId) throw new Error("confluence document missing id");
  const storage = asRecord(asRecord(record.body).storage);
  const links = asRecord(record._links);
  return {
    externalId,
    title: firstString(record, ["title", "name"]) ?? externalId,
    content: firstString(storage, ["value"]) ?? firstString(record, ["content"]) ?? "",
    url: firstString(record, ["url"]) ?? firstString(links, ["webui"]),
    mimeType: "text/html",
    updatedAt: firstString(record, ["updatedAt", "version"]) ?? null,
  };
}
