import { studioFetch } from "../../lib/client.js";
import { parseHttpError as parseError } from "@open-agent-tools/studio-client";

export interface Workspace {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export async function fetchWorkspaces(): Promise<Workspace[]> {
  const response = await studioFetch("/api/admin/workspaces");
  if (!response.ok) throw new Error(await parseError(response));
  return ((await response.json()) as { workspaces: Workspace[] }).workspaces;
}

export async function createWorkspace(input: {
  name: string;
  description?: string;
}): Promise<Workspace> {
  const response = await studioFetch("/api/admin/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await parseError(response));
  return ((await response.json()) as { workspace: Workspace }).workspace;
}

export interface UsageSummary {
  workspaceId: string;
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
  byModel: Array<{
    model: string;
    chatTurns: number;
    requests: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  bySource: Array<{
    source: "web_chat" | "app_chat" | "sql_query" | "rag_query" | "rag_graph";
    chatTurns: number;
    requests: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  byTool: Array<{ toolKind: string; toolName: string; calls: number; errors: number }>;
  daily: Array<{
    date: string;
    chatTurns: number;
    requests: number;
    toolCalls: number;
    totalTokens: number;
  }>;
}

/** 当前 workspace 的用量汇总（计费与扩容决策的证据）。`all=true` 查看全局合计。 */
export async function fetchUsage(options?: {
  days?: number;
  all?: boolean;
}): Promise<UsageSummary> {
  const params = new URLSearchParams({ days: String(options?.days ?? 30) });
  if (options?.all) params.set("workspaceId", "*");
  const response = await studioFetch(`/api/admin/usage?${params}`);
  if (!response.ok) throw new Error(await parseError(response));
  return ((await response.json()) as { usage: UsageSummary }).usage;
}
