import { studioFetch } from "../../lib/client.js";
import { parseHttpError as parseError } from "@open-agent-tools/studio-client";
import { asRecord } from "@open-agent-tools/api-contracts/values";
import { getAuditEvent, listAuditEvents } from "../mcp/api.js";
import type { AuditEventRecord, AuditEventSummary } from "../mcp/api.js";
import type { QueryAuditDetail, QueryAuditSummary } from "../observatory/api.js";

/**
 * 统一审计中心的接口层。
 *
 * 数据来自三个互不相同的来源，前端需要**并行调用后合并**，不能假设同源：
 * - 主服务 `/api/admin/audit/**`（IM 会话审计 + 聚合概览）
 * - 主服务 `/api/observatory/audits`（问数审计）与 `/api/admin/usage/events`（用量）
 * - Control Plane `/mcp-api/audit`（MCP 平台审计，独立进程与鉴权）
 */

/** IM 会话审计记录（前端归一化后的稳定字段）。 */
export interface ImChatAuditRecord {
  id: string;
  workspace: string;
  platform: string;
  channelId: string | null;
  channelName: string | null;
  sessionId: string | null;
  conversationId: string | null;
  actor: string;
  actorName: string | null;
  /** 单聊 / 群聊（服务端取值 `p2p` / `group`）。 */
  chatType: string;
  question: string;
  answer: string;
  status: string;
  /** ISO 时间字符串（服务端落库为毫秒时间戳）。 */
  createdAt: string;
  durationMs: number;
  toolCalls: number;
  citationCount: number;
  error: string | null;
}

/** IM 会话审计详情：在摘要基础上补充全文与引用明细。 */
export interface ImChatAuditDetail extends ImChatAuditRecord {
  question: string;
  answer: string;
  tools: string[];
  citations: Array<{ title?: string; url?: string; snippet?: string }>;
  raw: Record<string, unknown>;
}

export interface ImChatAuditFilters {
  workspace?: string;
  platform?: string;
  channelId?: string;
  actor?: string;
  chatType?: string;
  status?: string;
  /** 毫秒时间戳（服务端按 `created_at` 过滤）；也接受 ISO 字符串，内部转换。 */
  from?: number | string;
  /** 毫秒时间戳；也接受 ISO 字符串。 */
  to?: number | string;
  keyword?: string;
  limit?: number;
  offset?: number;
}

export interface ImChatAuditList {
  records: ImChatAuditRecord[];
  total: number;
}

/** 聚合概览分节（IM / 问数 / 用量 / MCP 的条目摘要）。 */
export interface AuditOverviewItem {
  id?: string;
  label?: string;
  value?: string | number;
  createdAt?: string;
  status?: string;
}

export interface AuditOverviewSection {
  key: string;
  title: string;
  total: number;
  items: AuditOverviewItem[];
}

export interface AuditOverview {
  sections: AuditOverviewSection[];
  /** 服务端说明：MCP section 不在此接口，需前端并行调用 Control Plane 合并。 */
  note?: string;
}

/** 用量事件（对齐服务端 `/api/admin/usage/events`）。 */
export interface UsageEventRecord {
  id: string;
  kind: "chat" | "tool";
  source?: string;
  requests?: number;
  workspaceId?: string | null;
  sessionId?: string | null;
  providerId?: string | null;
  model?: string | null;
  toolKind?: string | null;
  toolName?: string | null;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  durationMs: number;
  status: "ok" | "error" | "cancelled";
  createdAt: number;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await studioFetch(path, init);
  if (!response.ok) throw new Error(await parseError(response));
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function pickString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number") return String(value);
  }
  return null;
}

function pickNumber(source: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return 0;
}

function pickList(source: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) {
      return value
        .map((item) =>
          typeof item === "string"
            ? item
            : typeof item === "object" && item !== null
              ? (pickString(asRecord(item), ["name", "toolName", "title"]) ?? "")
              : "",
        )
        .filter((item) => item.length > 0);
    }
  }
  return [];
}

/** 服务端字段名尚未完全确定，这里对常见别名做归一化，UI 只依赖稳定字段。 */
export function normalizeImChatAudit(raw: unknown): ImChatAuditRecord {
  const source = asRecord(raw);
  const detail = asRecord(source.detail);
  const merged = { ...source, ...detail };
  const createdAt = pickTimestamp(merged, ["createdAt", "created_at", "startedAt", "started_at"]);
  return {
    id: pickString(merged, ["id", "auditId", "audit_id"]) ?? "",
    workspace: pickString(merged, ["workspace", "workspaceId", "workspace_id"]) ?? "",
    platform: pickString(merged, ["platform"]) ?? "",
    channelId: pickString(merged, ["channelId", "channel_id"]),
    channelName: pickString(merged, ["channelName", "channel_name"]),
    sessionId: pickString(merged, ["sessionId", "session_id"]),
    conversationId: pickString(merged, ["conversationId", "conversation_id"]),
    actor: pickString(merged, ["actor", "actorId", "actor_id"]) ?? "",
    actorName: pickString(merged, ["actorName", "actor_name", "nickname"]),
    chatType: pickString(merged, ["chatType", "chat_type", "conversationType"]) ?? "unknown",
    question: pickString(merged, ["question", "prompt", "userMessage", "user_message"]) ?? "",
    answer:
      pickString(merged, ["answer", "response", "assistantMessage", "assistant_message"]) ?? "",
    status: pickString(merged, ["status", "outcome"]) ?? "unknown",
    createdAt: createdAt === null ? "" : new Date(createdAt).toISOString(),
    durationMs: pickNumber(merged, ["durationMs", "duration_ms", "latencyMs", "latency_ms"]),
    toolCalls: pickNumber(merged, ["toolCalls", "tool_calls", "toolCallCount", "tool_call_count"]),
    citationCount: pickNumber(merged, [
      "citationCount",
      "citation_count",
      "citations",
      "referenceCount",
      "reference_count",
    ]),
    error: pickString(merged, ["error", "errorMessage", "error_message"]),
  };
}

/** 服务端 IM 审计时间字段是毫秒时间戳；也兼容 ISO 字符串。 */
function pickTimestamp(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return null;
}

function toQuery(filters: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

/**
 * 时间参数归一化为服务端要求的**毫秒时间戳**。
 * 服务端 IM 审计按 `created_at`（毫秒）过滤，ISO 字符串会被判为非法。
 */
export function toTimestamp(value: number | string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** 拉取 IM 会话审计列表。 */
export async function fetchImChatAudits(
  filters: ImChatAuditFilters = {},
): Promise<ImChatAuditList> {
  const query = toQuery({
    workspace: filters.workspace,
    platform: filters.platform,
    channelId: filters.channelId,
    actor: filters.actor,
    chatType: filters.chatType,
    status: filters.status,
    from: toTimestamp(filters.from),
    to: toTimestamp(filters.to),
    keyword: filters.keyword,
    limit: filters.limit,
    offset: filters.offset,
  });
  const body = await request<{
    records?: unknown[];
    audits?: unknown[];
    items?: unknown[];
    total?: number;
    count?: number;
  }>(`/api/admin/audit/im/audits${query}`, {
    // 服务端按 `x-workspace-id` 头归集工作区，查询参数里的 workspace 只作兼容。
    ...(filters.workspace ? { headers: { "x-workspace-id": filters.workspace } } : {}),
  });
  const rows = body.records ?? body.audits ?? body.items ?? [];
  return {
    records: rows.map(normalizeImChatAudit),
    total: body.total ?? body.count ?? rows.length,
  };
}

/** 拉取单条 IM 会话审计详情（响应体为 `{ audit }`）。 */
export async function fetchImChatAuditDetail(
  id: string,
  workspace?: string,
): Promise<ImChatAuditDetail> {
  const body = await request<unknown>(
    `/api/admin/audit/im/audits/${encodeURIComponent(id)}`,
    workspace ? { headers: { "x-workspace-id": workspace } } : undefined,
  );
  const source = asRecord(body);
  const inner = asRecord(source.audit ?? source.record);
  const record = normalizeImChatAudit(source.audit ?? source.record ?? body);
  // 工具 / 引用可能挂在 audit 内，也可能挂在顶层，两处都取。
  const innerTools = pickList(inner, ["tools", "toolCalls", "tool_calls"]);
  const innerCitations = pickCitationList(inner);
  return {
    ...record,
    tools: innerTools.length ? innerTools : pickList(source, ["tools", "toolCalls", "tool_calls"]),
    citations: innerCitations.length ? innerCitations : pickCitationList(source),
    raw: source,
  };
}

function pickCitationList(source: Record<string, unknown>): ImChatAuditDetail["citations"] {
  const value = source.citations ?? source.references ?? source.sources;
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item !== "number")
    .map((item) => {
      const entry = asRecord(item);
      return {
        title: pickString(entry, ["title", "name"]) ?? "",
        url: pickString(entry, ["url", "link"]) ?? "",
        snippet: pickString(entry, ["snippet", "text", "content"]) ?? "",
      };
    });
}

/** 统一审计概览：各分节的条目数量与最近条目。 */
export async function fetchAuditOverview(
  filters: {
    workspace?: string;
    from?: number | string;
    to?: number | string;
    limit?: number;
  } = {},
): Promise<AuditOverview> {
  const query = toQuery({
    workspace: filters.workspace,
    from: toTimestamp(filters.from),
    to: toTimestamp(filters.to),
    limit: filters.limit,
  });
  const body = await request<{
    sections?: AuditOverviewSection[];
    data?: AuditOverviewSection[];
    note?: string;
  }>(`/api/admin/audit/overview${query}`, {
    // 工作区由 `x-workspace-id` 头声明（服务端按头归集，查询参数只作兼容）。
    ...(filters.workspace ? { headers: { "x-workspace-id": filters.workspace } } : {}),
  });
  return { sections: body.sections ?? body.data ?? [], note: body.note };
}

/** 用量事件（复用主服务 `/api/admin/usage/events`）。 */
export async function fetchUsageEvents(
  options: { limit?: number; workspaceId?: string; workspace?: string } = {},
): Promise<UsageEventRecord[]> {
  const query = toQuery({
    limit: options.limit ?? 50,
    workspaceId: options.workspaceId,
  });
  const body = await request<{ events?: UsageEventRecord[] }>(`/api/admin/usage/events${query}`, {
    ...(options.workspace ? { headers: { "x-workspace-id": options.workspace } } : {}),
  });
  return body.events ?? [];
}

/**
 * 问数审计摘要（只读调用主服务 `/api/observatory/audits`）。
 *
 * 与 observatory 既有实现共用同一接口与类型，区别只在于这里显式带上
 * 审计中心顶部选中的工作区（observatory 的封装读的是全局 localStorage）。
 */
export async function fetchQueryAuditSummaries(
  filters: { from?: string; to?: string; limit?: number; offset?: number },
  workspace?: string,
): Promise<{ records: QueryAuditSummary[]; total: number }> {
  const query = toQuery({
    from: filters.from,
    to: filters.to,
    limit: filters.limit,
    offset: filters.offset,
  });
  return request<{ records: QueryAuditSummary[]; total: number }>(
    `/api/observatory/audits${query}`,
    {
      ...(workspace ? { headers: { "x-workspace-id": workspace } } : {}),
    },
  );
}

/**
 * MCP 平台审计。
 *
 * Control Plane 与 Agent Server 分进程，这里复用 `features/mcp/api.ts` 的
 * `listAuditEvents` / `getAuditEvent`，失败时由调用方降级展示。
 */
export async function fetchMcpAuditEvents(
  filters: { outcome?: AuditEventSummary["outcome"]; action?: string } = {},
): Promise<AuditEventSummary[]> {
  return listAuditEvents(filters);
}

export async function fetchMcpAuditDetail(id: string): Promise<AuditEventRecord> {
  return getAuditEvent(id);
}

export type AuditDetailSelection =
  | { kind: "im"; id: string; workspace?: string }
  | { kind: "query"; id: string; workspace?: string }
  | { kind: "usage"; event: UsageEventRecord }
  | { kind: "mcp"; id: string };

export type AuditDetail =
  | { kind: "im"; record: ImChatAuditDetail }
  | { kind: "query"; detail: QueryAuditDetail }
  | { kind: "usage"; record: UsageEventRecord }
  | { kind: "mcp"; record: AuditEventRecord };

export async function fetchAuditDetail(selection: AuditDetailSelection): Promise<AuditDetail> {
  switch (selection.kind) {
    case "im":
      return {
        kind: "im",
        record: await fetchImChatAuditDetail(selection.id, selection.workspace),
      };
    case "query":
      return {
        kind: "query",
        detail: await request<QueryAuditDetail>(
          `/api/observatory/audits/${encodeURIComponent(selection.id)}`,
          selection.workspace ? { headers: { "x-workspace-id": selection.workspace } } : undefined,
        ),
      };
    case "mcp":
      return { kind: "mcp", record: await fetchMcpAuditDetail(selection.id) };
    case "usage":
      // 用量列表已返回完整的不可变计量事件，无需另造详情接口。
      return { kind: "usage", record: selection.event };
  }
}
