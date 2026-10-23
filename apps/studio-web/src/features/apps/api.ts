import type { ChatRequestMessage, MessageUsage, ToolCall } from "../../types.js";
import { localMessage as createLocalMessage } from "@open-agent-tools/studio-client";
import { parseSseBuffer } from "../../lib/api.js";
import { parseHttpError as parseError } from "@open-agent-tools/studio-client";

export interface AppChatProfile {
  slug: string;
  name: string;
  description: string;
  welcome: string;
  suggestions: Array<{ title: string; prompt: string }>;
  capabilities: { ragSources: number; mcpTools: number; sqlSources: number };
  quota?: { rateLimitPerMinute: number; dailyTokenBudget: number; usedTokensToday: number };
}

/** 访问口令：优先 URL query（分享链接），其次 localStorage（避免刷新后丢失）。 */
const ACCESS_TOKEN_KEY = (slug: string) => `open-agent-tools.app-token.${slug}`;

/** 读取当前 URL 的 access_token；非浏览器环境（测试/SSR）返回 null。 */
function tokenFromLocation(): string | null {
  // 直接探测 globalThis.location：浏览器与测试替身都适用，不依赖 window。
  const location = (globalThis as { location?: { search?: string; hash?: string } }).location;
  if (!location) return null;
  const fromQuery = new URLSearchParams(location.search ?? "").get("access_token")?.trim();
  if (fromQuery) return fromQuery;
  // hash 路由里也可能带 query（#/app/hr?access_token=xxx）
  const hashQuery = (location.hash ?? "").split("?")[1];
  if (!hashQuery) return null;
  const fromHash = new URLSearchParams(hashQuery).get("access_token")?.trim();
  return fromHash || null;
}

export function resolveAppAccessToken(slug: string): string | null {
  const fromQuery = tokenFromLocation();
  if (fromQuery) {
    try {
      globalThis.localStorage?.setItem(ACCESS_TOKEN_KEY(slug), fromQuery);
    } catch {
      // 隐私模式下写入失败不影响本次使用
    }
    return fromQuery;
  }
  try {
    return globalThis.localStorage?.getItem(ACCESS_TOKEN_KEY(slug)) ?? null;
  } catch {
    return null;
  }
}

function accessHeaders(slug: string): Record<string, string> {
  const token = resolveAppAccessToken(slug);
  return token ? { "x-app-access-token": token } : {};
}

/** 读取发布应用外观（终端用户入口，无需部署 token；口令模式需带 access_token）。 */
export async function fetchAppProfile(slug: string): Promise<AppChatProfile> {
  const response = await fetch(`/api/apps/${encodeURIComponent(slug)}`, {
    headers: accessHeaders(slug),
  });
  if (!response.ok) throw new Error(await parseError(response));
  return ((await response.json()) as { app: AppChatProfile }).app;
}

export interface AppChatHandlers {
  onDelta: (delta: string) => void;
  onDone: () => void;
  onUsage?: (usage: MessageUsage) => void;
  onError: (error: string) => void;
  onStopped?: () => void;
  onAssistantMessageId?: (id: string) => void;
  onToolCall?: (call: ToolCall) => void;
  onToolResult?: (result: { id?: string; name: string; error?: string }) => void;
}

interface AppChatOptions {
  sessionId?: string;
}

/**
 * 员工侧对话：只发送 messages 与 sessionId。
 *
 * 资源范围、provider、模型全部由服务端发布配置决定。
 * 分组身份只能由企业网关通过签名断言注入；浏览器请求体永远不包含 viewerGroups。
 * 返回 AbortController 以便「停止生成」。
 */
export function streamAppChat(
  slug: string,
  messages: ChatRequestMessage[],
  handlers: AppChatHandlers,
  options?: AppChatOptions,
): AbortController {
  const controller = new AbortController();

  void (async () => {
    try {
      const response = await fetch(`/api/apps/${encodeURIComponent(slug)}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", ...accessHeaders(slug) },
        body: JSON.stringify({
          messages,
          sessionId: options?.sessionId,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        handlers.onError(await parseError(response));
        return;
      }
      const reader = response.body?.getReader();
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
          if (event.usage) handlers.onUsage?.(event.usage as MessageUsage);
          if (typeof event.assistantMessageId === "string") {
            handlers.onAssistantMessageId?.(event.assistantMessageId);
          }
          if (event.tool_call) handlers.onToolCall?.(event.tool_call as ToolCall);
          if (event.tool_result) {
            handlers.onToolResult?.(
              event.tool_result as { id?: string; name: string; error?: string },
            );
          }
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
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        handlers.onStopped?.();
        return;
      }
      handlers.onError(error instanceof Error ? error.message : "请求失败");
    }
  })();

  return controller;
}

/** 本地消息构造（员工侧不需要持久化到 localStorage）。 */
export const localMessage = createLocalMessage;
