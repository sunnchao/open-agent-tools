/**
 * 记忆管理前端接口层。
 *
 * 与后端 `routes/memory.ts` 一一对应；所有写操作都带 workspace 头
 * （`studioFetch` 已统一注入），错误统一走 `parseHttpError`。
 */
import { studioFetch } from "../../lib/client.js";
import { parseHttpError as parseError } from "@open-agent-tools/studio-client";

export type MemoryKind = "preference" | "fact" | "decision" | "constraint";
export type MemoryScopeKind = "person" | "group";
export type MemoryStatus = "active" | "superseded" | "expired";

/** 单条长期事实（后端 `MemoryFact` 的镜像）。 */
export interface MemoryFact {
  id: string;
  workspaceId: string;
  channelId: string | null;
  scopeKind: MemoryScopeKind;
  scopeKey: string;
  subject: string;
  kind: MemoryKind;
  slug: string;
  body: string;
  status: MemoryStatus;
  confidence: "high" | "medium" | "low" | "unknown";
  unreviewed: boolean;
  sourceSessionId: string | null;
  sourceMessageId: string | null;
  validFrom: string | null;
  validTo: string | null;
  recordedAt: number;
  updatedAt: number;
  supersedesId: string | null;
}

export interface MemoryFactPage {
  facts: MemoryFact[];
  total: number;
}

export interface MemoryFactQuery {
  scopeKind?: MemoryScopeKind;
  scopeKey?: string;
  status?: MemoryStatus | "all";
  keyword?: string;
  /** 是否包含待审核（默认包含，管理页需要看到全部）。 */
  includeUnreviewed?: boolean;
  limit?: number;
  offset?: number;
}

export async function fetchMemoryFacts(query: MemoryFactQuery = {}): Promise<MemoryFactPage> {
  const params = new URLSearchParams();
  if (query.scopeKind) params.set("scopeKind", query.scopeKind);
  if (query.scopeKey) params.set("scopeKey", query.scopeKey);
  if (query.status) params.set("status", query.status);
  if (query.keyword) params.set("keyword", query.keyword);
  if (query.includeUnreviewed) params.set("all", "1");
  if (query.limit) params.set("limit", String(query.limit));
  if (query.offset) params.set("offset", String(query.offset));
  const suffix = params.toString();
  const response = await studioFetch(`/api/memory/facts${suffix ? `?${suffix}` : ""}`);
  if (!response.ok) throw new Error(await parseError(response));
  return (await response.json()) as MemoryFactPage;
}

export async function fetchMemoryFact(
  id: string,
): Promise<{ fact: MemoryFact; history: MemoryFact[] }> {
  const response = await studioFetch(`/api/memory/facts/${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error(await parseError(response));
  return (await response.json()) as { fact: MemoryFact; history: MemoryFact[] };
}

/** 接受或拒绝一条提议；拒绝会物理删除，调用方必须先二次确认。 */
export async function reviewMemoryFact(id: string, accepted: boolean): Promise<void> {
  const response = await studioFetch(`/api/memory/facts/${encodeURIComponent(id)}/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accepted }),
  });
  if (!response.ok) throw new Error(await parseError(response));
}

export async function forgetMemoryFacts(target: {
  sessionId?: string;
  personId?: string;
}): Promise<{ facts: number; summaries: number; lineage: number }> {
  const params = new URLSearchParams();
  if (target.sessionId) params.set("sessionId", target.sessionId);
  if (target.personId) params.set("personId", target.personId);
  const response = await studioFetch(`/api/memory/facts?${params.toString()}`, {
    method: "DELETE",
  });
  if (!response.ok) throw new Error(await parseError(response));
  return (await response.json()) as { facts: number; summaries: number; lineage: number };
}

export interface MemoryStats {
  active: number;
  unreviewed: number;
  superseded: number;
  expired: number;
  persons: number;
  groups: number;
  byKind: Partial<Record<MemoryKind, number>>;
  byScope: Partial<Record<MemoryScopeKind, number>>;
}

export async function fetchMemoryStats(): Promise<{
  stats: MemoryStats;
  recent: MemoryFact[];
}> {
  const response = await studioFetch("/api/memory/stats");
  if (!response.ok) throw new Error(await parseError(response));
  return (await response.json()) as { stats: MemoryStats; recent: MemoryFact[] };
}

export interface ForgetPreview {
  facts: number;
  summaries: number;
  lineage: number;
  /** 不在遗忘范围内的数据，必须展示给用户。 */
  untouched: string[];
}

export async function previewForget(target: {
  sessionId?: string;
  personId?: string;
}): Promise<ForgetPreview> {
  const params = new URLSearchParams();
  if (target.sessionId) params.set("sessionId", target.sessionId);
  if (target.personId) params.set("personId", target.personId);
  const response = await studioFetch(`/api/memory/forget/preview?${params.toString()}`);
  if (!response.ok) throw new Error(await parseError(response));
  return (await response.json()) as ForgetPreview;
}

/** 批量审核：逐条独立处理，返回成功与失败明细。 */
export async function reviewMemoryFacts(
  ids: string[],
  accepted: boolean,
): Promise<{ succeeded: string[]; failed: Array<{ id: string; error: string }> }> {
  const response = await studioFetch("/api/memory/facts/review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, accepted }),
  });
  if (!response.ok) throw new Error(await parseError(response));
  return (await response.json()) as {
    succeeded: string[];
    failed: Array<{ id: string; error: string }>;
  };
}

/** 展示用标签：避免在组件里散落中文字面量。 */
export const MEMORY_KIND_LABEL: Record<MemoryKind, string> = {
  preference: "偏好",
  fact: "事实",
  decision: "决议",
  constraint: "约束",
};

export const MEMORY_SCOPE_LABEL: Record<MemoryScopeKind, string> = {
  person: "个人",
  group: "群组",
};

export const MEMORY_STATUS_LABEL: Record<MemoryStatus, string> = {
  active: "生效中",
  superseded: "已失效",
  expired: "已过期",
};
