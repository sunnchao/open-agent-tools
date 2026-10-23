import type { ChatRequestMessage, ToolCall } from "../lib/types";
import { localMessage as createLocalMessage } from "@open-agent-tools/studio-client";
export { employeeEntryPath } from "@open-agent-tools/studio-client";
import { parseSseBuffer } from "../lib/sse";
import { agentFetch, parseError } from "../lib/http";
import { storageGet, storageSet } from "../lib/storage";

export interface AppChatProfile {
  slug: string;
  name: string;
  description: string;
  welcome: string;
  suggestions: Array<{ title: string; prompt: string }>;
  capabilities: { ragSources: number; mcpTools: number; sqlSources: number };
  quota?: { rateLimitPerMinute: number; dailyTokenBudget: number; usedTokensToday: number };
}
const ACCESS_TOKEN_KEY = (slug: string) => `open-agent-tools.app-token.${slug}`;
export async function resolveAppAccessToken(slug: string): Promise<string | null> {
  try {
    return (await storageGet(ACCESS_TOKEN_KEY(slug))) ?? null;
  } catch {
    return null;
  }
}
export async function saveAppAccessToken(slug: string, token: string): Promise<void> {
  await storageSet(ACCESS_TOKEN_KEY(slug), token).catch(() => undefined);
}
export async function fetchAppProfile(slug: string): Promise<AppChatProfile> {
  const token = await resolveAppAccessToken(slug);
  const r = await agentFetch(`/api/apps/${encodeURIComponent(slug)}`, {
    headers: token ? { "x-app-access-token": token } : {},
  });
  if (!r.ok) throw new Error(await parseError(r));
  return ((await r.json()) as { app: AppChatProfile }).app;
}
export interface AppChatHandlers {
  onDelta: (d: string) => void;
  onDone: () => void;
  onError: (e: string) => void;
  onStopped?: () => void;
  onAssistantMessageId?: (id: string) => void;
  onToolCall?: (c: ToolCall) => void;
  onToolResult?: (r: { id?: string; name: string; error?: string }) => void;
}
export function streamAppChat(
  slug: string,
  messages: ChatRequestMessage[],
  handlers: AppChatHandlers,
  options?: { sessionId?: string },
): { abort: () => void } {
  const controller = new AbortController();
  void (async () => {
    try {
      const token = await resolveAppAccessToken(slug);
      const response = await agentFetch(`/api/apps/${encodeURIComponent(slug)}/chat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { "x-app-access-token": token } : {}),
        },
        body: JSON.stringify({ messages, sessionId: options?.sessionId }),
        signal: controller.signal,
      });
      if (!response.ok) {
        handlers.onError(await parseError(response));
        return;
      }
      const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader?.();
      if (!reader) {
        handlers.onError("No response body");
        return;
      }
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = parseSseBuffer(buffer);
        buffer = rest;
        for (const event of events) {
          if (typeof event.assistantMessageId === "string")
            handlers.onAssistantMessageId?.(event.assistantMessageId);
          if (event.tool_call) handlers.onToolCall?.(event.tool_call as ToolCall);
          if (event.tool_result)
            handlers.onToolResult?.(
              event.tool_result as { id?: string; name: string; error?: string },
            );
          if (event.error) {
            handlers.onError(String(event.error));
            return;
          }
          if (event.delta) handlers.onDelta(String(event.delta));
          if (event.done) {
            handlers.onDone();
            return;
          }
        }
      }
      handlers.onDone();
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        handlers.onStopped?.();
        return;
      }
      handlers.onError(e instanceof Error ? e.message : "请求失败");
    }
  })();
  return { abort: () => controller.abort() };
}
export const localMessage = createLocalMessage;
