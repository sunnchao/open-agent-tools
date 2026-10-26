import { randomUUID } from "node:crypto";
import { DEFAULT_WORKSPACE_ID, openDb } from "../db.js";

export type UsageEventKind = "chat" | "tool";
export type UsageToolKind = "mcp" | "sql" | "builtin";
export type UsageSource = "web_chat" | "app_chat" | "sql_query" | "rag_query" | "rag_graph";

export interface UsageEventInput {
  kind: UsageEventKind;
  source?: UsageSource;
  requests?: number;
  workspaceId?: string | null;
  sessionId?: string | null;
  providerId?: string | null;
  model?: string | null;
  toolKind?: UsageToolKind | null;
  toolName?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  toolCalls?: number;
  durationMs?: number;
  status?: "ok" | "error" | "cancelled";
}

export interface UsageEvent extends UsageEventInput {
  id: string;
  createdAt: number;
  // 落库前已归一化，读回时这些字段一定是具体数值。
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  durationMs: number;
  status: "ok" | "error" | "cancelled";
  source: UsageSource;
  requests: number;
}

export interface UsageBreakdown {
  chatTurns: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageSummary {
  from: number;
  to: number;
  totals: {
    events: number;
    chatTurns: number;
    requests: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    chatDurationMs: number;
    toolDurationMs: number;
  };
  byModel: Array<{ model: string } & UsageBreakdown>;
  bySource: Array<{ source: UsageSource } & UsageBreakdown>;
  byTool: Array<{ toolKind: string; toolName: string; calls: number; errors: number }>;
  daily: Array<{
    date: string;
    chatTurns: number;
    requests: number;
    toolCalls: number;
    totalTokens: number;
  }>;
}

function sanitizeNumbers(
  value: UsageEventInput,
): Required<
  Pick<UsageEventInput, "requests" | "inputTokens" | "outputTokens" | "toolCalls" | "durationMs">
> {
  const finite = (n: number | undefined): number =>
    Number.isFinite(n) && (n ?? 0) >= 0 ? Math.floor(n ?? 0) : 0;
  return {
    requests: finite(value.requests ?? (value.kind === "chat" ? 1 : 0)),
    inputTokens: finite(value.inputTokens),
    outputTokens: finite(value.outputTokens),
    toolCalls: finite(value.toolCalls),
    durationMs: finite(value.durationMs),
  };
}

/**
 * 记录一条用量事件（账单与成本对账的原始凭证）。
 * 只追加、不更新，失败时不抛错——计量不能把业务请求拖垮。
 */
export function recordUsageEvent(
  input: UsageEventInput,
  identity?: { id: string; createdAt: number },
): UsageEvent | null {
  if (input.kind !== "chat" && input.kind !== "tool") return null;
  const numbers = sanitizeNumbers(input);
  const event: UsageEvent = {
    id: identity?.id ?? randomUUID(),
    kind: input.kind,
    source: input.source ?? "web_chat",
    // 未显式指定归属时落到默认空间：否则按空间过滤会把无归属事件整个漏掉。
    workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
    sessionId: input.sessionId ?? null,
    providerId: input.providerId ?? null,
    model: input.model ?? null,
    toolKind: input.toolKind ?? null,
    toolName: input.toolName ?? null,
    ...numbers,
    status: input.status ?? "ok",
    createdAt: identity?.createdAt ?? Date.now(),
  };
  try {
    openDb()
      .prepare(
        `INSERT OR IGNORE INTO usage_events (
           id, kind, workspace_id, session_id, provider_id, model, tool_kind, tool_name,
           source, requests, input_tokens, output_tokens, tool_calls, duration_ms, status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.kind,
        event.workspaceId ?? null,
        event.sessionId ?? null,
        event.providerId ?? null,
        event.model ?? null,
        event.toolKind ?? null,
        event.toolName ?? null,
        event.source,
        event.requests,
        event.inputTokens,
        event.outputTokens,
        event.toolCalls,
        event.durationMs,
        event.status,
        event.createdAt,
      );
    return event;
  } catch {
    return null;
  }
}

function dayKey(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

interface UsageRow {
  kind: string;
  source: UsageSource;
  requests: number;
  workspace_id: string | null;
  session_id: string | null;
  provider_id: string | null;
  model: string | null;
  tool_kind: string | null;
  tool_name: string | null;
  input_tokens: number;
  output_tokens: number;
  tool_calls: number;
  duration_ms: number;
  status: string;
  created_at: number;
}

/** 按时间窗汇总用量（续费谈判与扩容决策的直接依据）。传 workspaceId 可按空间归集。 */
export function summarizeUsage(from?: number, to?: number, workspaceId?: string): UsageSummary {
  const end = Number.isFinite(to) ? Number(to) : Date.now();
  const start = Number.isFinite(from) ? Number(from) : end - 30 * 24 * 60 * 60 * 1000;
  const scope = workspaceId ? " AND workspace_id = ?" : "";
  const rows = openDb()
    .prepare(
      `SELECT kind, source, requests, workspace_id, session_id, provider_id, model, tool_kind, tool_name,
              input_tokens, output_tokens, tool_calls, duration_ms, status, created_at
       FROM usage_events
       WHERE created_at >= ? AND created_at <= ?${scope}
       ORDER BY created_at ASC`,
    )
    .all(...(workspaceId ? [start, end, workspaceId] : [start, end])) as unknown as UsageRow[];

  const summary: UsageSummary = {
    from: start,
    to: end,
    totals: {
      events: 0,
      chatTurns: 0,
      requests: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      chatDurationMs: 0,
      toolDurationMs: 0,
    },
    byModel: [],
    bySource: [],
    byTool: [],
    daily: [],
  };
  const models = new Map<string, UsageBreakdown>();
  const sources = new Map<UsageSource, UsageBreakdown>();
  const tools = new Map<
    string,
    { toolKind: string; toolName: string; calls: number; errors: number }
  >();
  const days = new Map<
    string,
    {
      chatTurns: number;
      requests: number;
      toolCalls: number;
      inputTokens: number;
      outputTokens: number;
    }
  >();

  for (const row of rows) {
    const chatTurn =
      row.kind === "chat" && (row.source === "web_chat" || row.source === "app_chat");
    summary.totals.events += 1;
    summary.totals.requests += row.requests;
    summary.totals.inputTokens += row.input_tokens;
    summary.totals.outputTokens += row.output_tokens;
    if (row.kind === "chat") {
      if (chatTurn) summary.totals.chatTurns += 1;
      summary.totals.chatDurationMs += row.duration_ms;
      // 注意：chat 行的 tool_calls 只做元信息保留，不计入 toolCalls；
      // 工具调用总量以 kind='tool' 的单条事件为准，避免重复统计。
      const model = row.model ?? "unknown";
      const entry = models.get(model) ?? {
        chatTurns: 0,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      if (chatTurn) entry.chatTurns += 1;
      entry.requests += row.requests;
      entry.inputTokens += row.input_tokens;
      entry.outputTokens += row.output_tokens;
      models.set(model, entry);
    } else if (row.kind === "tool") {
      summary.totals.toolCalls += 1;
      summary.totals.toolDurationMs += row.duration_ms;
      const key = `${row.tool_kind ?? "unknown"}:${row.tool_name ?? "unknown"}`;
      const entry = tools.get(key) ?? {
        toolKind: row.tool_kind ?? "unknown",
        toolName: row.tool_name ?? "unknown",
        calls: 0,
        errors: 0,
      };
      entry.calls += 1;
      if (row.status === "error") entry.errors += 1;
      tools.set(key, entry);
    }
    const source = sources.get(row.source) ?? {
      chatTurns: 0,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    if (chatTurn) source.chatTurns += 1;
    source.requests += row.requests;
    source.inputTokens += row.input_tokens;
    source.outputTokens += row.output_tokens;
    sources.set(row.source, source);
    const day = days.get(dayKey(row.created_at)) ?? {
      chatTurns: 0,
      requests: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    if (chatTurn) day.chatTurns += 1;
    if (row.kind === "tool") day.toolCalls += 1;
    day.requests += row.requests;
    day.inputTokens += row.input_tokens;
    day.outputTokens += row.output_tokens;
    days.set(dayKey(row.created_at), day);
  }

  summary.totals.totalTokens = summary.totals.inputTokens + summary.totals.outputTokens;
  summary.byModel = [...models.entries()]
    .map(([model, entry]) => ({ model, ...entry }))
    .sort((left, right) => right.requests - left.requests);
  summary.byTool = [...tools.values()].sort((left, right) => right.calls - left.calls);
  summary.bySource = [...sources.entries()]
    .map(([source, entry]) => ({ source, ...entry }))
    .sort((left, right) => right.requests - left.requests);
  summary.daily = [...days.entries()]
    .map(([date, entry]) => ({
      date,
      chatTurns: entry.chatTurns,
      requests: entry.requests,
      toolCalls: entry.toolCalls,
      totalTokens: entry.inputTokens + entry.outputTokens,
    }))
    .sort((left, right) => (left.date < right.date ? -1 : 1));
  return summary;
}

/** 最近 N 条用量事件（排障与对账抽查用）。 */
export function listRecentUsage(limit = 50, workspaceId?: string): UsageEvent[] {
  const rows = openDb()
    .prepare(
      `SELECT id, kind, source, requests, workspace_id, session_id, provider_id, model, tool_kind, tool_name,
              input_tokens, output_tokens, tool_calls, duration_ms, status, created_at
       FROM usage_events
       ${workspaceId ? "WHERE workspace_id = ?" : ""}
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(
      ...(workspaceId
        ? [workspaceId, Math.max(1, Math.min(500, Math.floor(limit)))]
        : [Math.max(1, Math.min(500, Math.floor(limit)))]),
    ) as unknown as Array<{
    id: string;
    kind: UsageEventKind;
    source: UsageSource;
    requests: number;
    workspace_id: string | null;
    session_id: string | null;
    provider_id: string | null;
    model: string | null;
    tool_kind: UsageToolKind | null;
    tool_name: string | null;
    input_tokens: number;
    output_tokens: number;
    tool_calls: number;
    duration_ms: number;
    status: "ok" | "error" | "cancelled";
    created_at: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    source: row.source,
    requests: row.requests,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    providerId: row.provider_id,
    model: row.model,
    toolKind: row.tool_kind,
    toolName: row.tool_name,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    toolCalls: row.tool_calls,
    durationMs: row.duration_ms,
    status: row.status,
    createdAt: row.created_at,
  }));
}
