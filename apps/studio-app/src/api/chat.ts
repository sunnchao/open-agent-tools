import type {
  ChatRequestMessage,
  ChatResourceBinding,
  MessageUsage,
  RagCitation,
  Session,
  ToolCall,
} from "../lib/types";
import { agentFetch, parseError } from "../lib/http";
import { consumeSse } from "../lib/sse";

export interface StreamCallbacks {
  onDelta: (delta: string) => void;
  onDone: (meta?: { assistantMessageId?: string; usage?: MessageUsage }) => void;
  onError: (error: string) => void;
  onStopped?: () => void;
  onAssistantMessageId?: (id: string) => void;
  onRagCitations?: (citations: RagCitation[]) => void;
  onUsage?: (usage: MessageUsage) => void;
  onToolCall?: (call: ToolCall) => void;
  onToolResult?: (result: {
    id?: string;
    name: string;
    result?: unknown;
    ui?: unknown;
    error?: string;
  }) => void;
}

export async function fetchSessions(): Promise<Session[]> {
  const res = await agentFetch("/api/sessions");
  if (!res.ok) throw new Error(await parseError(res));
  return ((await res.json()) as { sessions: Session[] }).sessions;
}
export async function createSessionApi(input?: { id?: string; title?: string }): Promise<Session> {
  const res = await agentFetch("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input ?? {}),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return ((await res.json()) as { session: Session }).session;
}
export async function renameSessionApi(id: string, title: string): Promise<Session> {
  const res = await agentFetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return ((await res.json()) as { session: Session }).session;
}
export async function deleteSessionApi(id: string): Promise<void> {
  const res = await agentFetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error(await parseError(res));
}
export async function deleteMessageApi(id: string): Promise<void> {
  const res = await agentFetch(`/api/messages/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error(await parseError(res));
}

/** POST /api/chat 并解析 SSE（RN 兼容：stream/非 stream 自适应）。 */
export function streamChat(
  messages: ChatRequestMessage[],
  model: string | undefined,
  callbacks: StreamCallbacks,
  opts?: {
    sessionId?: string;
    userMessage?: { id?: string; content: string };
    resources?: ChatResourceBinding;
    providerId?: string;
  },
): { abort: () => void } {
  const controller = new AbortController();
  void (async () => {
    try {
      const res = await agentFetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages,
          model,
          sessionId: opts?.sessionId,
          userMessage: opts?.userMessage,
          resources: opts?.resources,
          ...(opts?.providerId ? { providerId: opts.providerId } : {}),
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        callbacks.onError(await parseError(res));
        return;
      }
      let assistantMessageId: string | undefined;
      let usage: MessageUsage | undefined;
      let finished = false;
      await consumeSse(res, (data) => {
        if (typeof data.assistantMessageId === "string") {
          assistantMessageId = data.assistantMessageId;
          callbacks.onAssistantMessageId?.(assistantMessageId);
        }
        if (data.tool_call) callbacks.onToolCall?.(data.tool_call as ToolCall);
        if (Array.isArray(data.rag_citations))
          callbacks.onRagCitations?.(data.rag_citations as RagCitation[]);
        if (data.usage && typeof data.usage === "object" && !data.done) {
          usage = data.usage as MessageUsage;
          callbacks.onUsage?.(usage);
        }
        if (data.tool_result)
          callbacks.onToolResult?.(
            data.tool_result as Parameters<NonNullable<StreamCallbacks["onToolResult"]>>[0],
          );
        if (data.error) {
          callbacks.onError(data.error as string);
          finished = true;
          return true;
        }
        if (data.done) {
          const finalUsage =
            data.usage && typeof data.usage === "object" ? (data.usage as MessageUsage) : usage;
          callbacks.onDone({ assistantMessageId, ...(finalUsage ? { usage: finalUsage } : {}) });
          finished = true;
          return true;
        }
        if (data.delta) callbacks.onDelta(data.delta as string);
        return false;
      });
      if (!finished) callbacks.onDone({ assistantMessageId, ...(usage ? { usage } : {}) });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        callbacks.onStopped?.();
        return;
      }
      callbacks.onError(err instanceof Error ? err.message : "Request failed");
    }
  })();
  return { abort: () => controller.abort() };
}
