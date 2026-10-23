import { createHash } from "node:crypto";
import { normalizeStringList as normalizePatterns } from "@open-agent-tools/api-contracts/values";

/**
 * 连接器框架的公共契约。
 *
 * 这里刻意把「配置」「拉取实现」「依赖」拆成三个独立概念:
 * - `ConnectorConfig` 是管理员在 Studio 里配置、并持久化到 SQLite 的一份数据;
 * - `Connector` 是一个纯函数式的拉取实现,只依赖传入的依赖,不做任何 IO 之外的事;
 * - `ConnectorDeps` 承载 fetch/fs/clock,保证单测可以完全离线运行。
 */
export type ConnectorType = "http" | "local-dir" | "feishu" | "yuque" | "confluence";

export const CONNECTOR_TYPES: readonly ConnectorType[] = [
  "http",
  "local-dir",
  "feishu",
  "yuque",
  "confluence",
];

export function isConnectorType(value: unknown): value is ConnectorType {
  return typeof value === "string" && (CONNECTOR_TYPES as readonly string[]).includes(value);
}

/** 过滤规则:include/exclude 按「子串或简单 * 通配」匹配外部 id 与标题。 */
export interface ConnectorFilter {
  include: string[];
  exclude: string[];
  maxDocuments: number | null;
}

export interface ConnectorConfig {
  id: string;
  name: string;
  type: ConnectorType;
  baseUrl: string | null;
  /** 已解密的凭据,例如 { token: "..." } 或 { appId, appSecret }。 */
  credentials: Record<string, string>;
  filter: ConnectorFilter;
  enabled: boolean;
}

/** 拉取到的单篇文档:标题 + 正文 + 稳定外部 id。 */
export interface ConnectorDocument {
  /** 外部系统的稳定标识(同一文档跨同步不变),去重与 rag source 命名都基于它。 */
  externalId: string;
  title: string;
  content: string;
  url: string | null;
  mimeType: string;
  /** 外部系统的更新时间(ISO 字符串);缺失时为空。 */
  updatedAt: string | null;
}

/** 只取用到的 fetch 能力,便于注入 stub。 */
export type HttpFetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** local-dir 连接器的最小文件系统抽象,注入后即可离线测试。 */
export interface ConnectorFsEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface ConnectorFileSystem {
  readdir(path: string): Promise<ConnectorFsEntry[]>;
  readFile(path: string): Promise<string>;
}

export interface ConnectorDeps {
  fetch?: HttpFetchLike;
  fs?: ConnectorFileSystem;
  now?: () => number;
}

export interface Connector {
  readonly type: ConnectorType;
  /**
   * 拉取全部文档。实现必须使用 `deps.fetch` / `deps.fs`,不得直接触碰全局,
   * 否则离线测试会失效。
   */
  fetchDocuments(config: ConnectorConfig, deps: ConnectorDeps): Promise<ConnectorDocument[]>;
}

export const DEFAULT_FILTER: ConnectorFilter = {
  include: [],
  exclude: [],
  maxDocuments: null,
};

export function normalizeFilter(value: unknown): ConnectorFilter {
  const raw = (value ?? {}) as Record<string, unknown>;
  return {
    include: normalizePatterns(raw.include),
    exclude: normalizePatterns(raw.exclude),
    maxDocuments: normalizeMaxDocuments(raw.maxDocuments),
  };
}

function normalizeMaxDocuments(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

/** 把 glob 风格通配转成正则;非通配时退化为「包含」匹配,便于写人话过滤规则。 */
function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(escaped, "i");
}

function matchesAny(haystack: string, patterns: string[]): boolean {
  return patterns.some((pattern) => patternToRegExp(pattern).test(haystack));
}

/** 统一应用过滤规则:先 include 后 exclude,最后按 maxDocuments 截断。 */
export function applyFilter(
  documents: ConnectorDocument[],
  filter: ConnectorFilter,
): ConnectorDocument[] {
  const kept = documents.filter((document) => {
    const haystack = `${document.externalId} ${document.title}`;
    if (filter.include.length > 0 && !matchesAny(haystack, filter.include)) return false;
    if (filter.exclude.length > 0 && matchesAny(haystack, filter.exclude)) return false;
    return true;
  });
  return filter.maxDocuments ? kept.slice(0, filter.maxDocuments) : kept;
}

/** 去重键:外部 id + 正文哈希,内容未变时同步直接跳过。 */
export function contentHashOf(document: Pick<ConnectorDocument, "title" | "content">): string {
  return createHash("sha256").update(`${document.title}\u0000${document.content}`).digest("hex");
}

/** 把外部 id 转成安全的 rag source 文件名,保证同一外部 id 稳定映射到同一文件。 */
export function ragSourceName(connectorId: string, externalId: string): string {
  const slug = externalId
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${connectorId}-${slug || "document"}.md`;
}
