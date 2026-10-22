/**
 * 调用本服务 /api/chat 完成一轮知识库问答。
 *
 * 复用平台完整的 Agent Chat 链路（Provider 解析、CRAG 混合检索、工具轮次），
 * 通过 SSE 收集 delta 增量拼出最终文本。返回空串表示无回答。
 */

import { logTrace } from "../trace.js";

export interface ChatAnswer {
  content: string;
  /** 本轮触发的工具名（按出现顺序去重前的原始列表）。 */
  toolCalls: string[];
  /** 本轮返回的工具结果条数。 */
  toolResultCount: number;
  /** 本轮引用的知识片段数。 */
  citations: number;
}

/** IM 渠道绑定的 MCP 工具；与 /api/chat 的 resources.mcpTools 结构一致。 */
export interface ChatMcpToolBinding {
  serviceSlug: string;
  toolName: string;
}

/**
 * 失效工具的最大降级重试次数。
 * 渠道绑定是长生命周期的：MCP 服务下线/工具改名后，绑定不会自动失效，
 * 而 /api/chat 解析工具时会直接报错。这里有界地摘掉失效工具重试，保证机器人不瘫。
 */
const MAX_MCP_DEGRADE_RETRIES = 5;

/** /api/chat 解析 MCP 工具失败时的错误格式。 */
const UNAVAILABLE_TOOL_PATTERN = /^MCP Tool is unavailable: (.+)\/(.+)$/;

/** 解析出错的 MCP 工具；不匹配返回 null。 */
export function parseUnavailableTool(error: unknown): ChatMcpToolBinding | null {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const matched = UNAVAILABLE_TOOL_PATTERN.exec(message.trim());
  if (!matched) return null;
  const serviceSlug = matched[1]?.trim();
  const toolName = matched[2]?.trim();
  if (!serviceSlug || !toolName) return null;
  return { serviceSlug, toolName };
}

/**
 * 解析一条 SSE 帧（`data: {...}`）。
 *
 * 返回 delta 增量 / error / 工具调用与引用计数；非数据帧与坏帧返回 null。
 * 未知事件（如 done、usage、assistantMessageId）一律忽略，向后兼容旧服务端。
 */
export interface ChatSseEvent {
  delta?: string;
  error?: string;
  /** 工具名。 */
  toolCall?: string;
  /** 工具结果条数（每次 tool_result 事件 +1）。 */
  toolResult?: boolean;
  /** 引用片段数（rag_citations 数组长度）。 */
  citations?: number;
}

export function parseChatSseEvent(line: string): ChatSseEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const payload = trimmed.slice(5).trim();
  if (!payload) return null;
  try {
    const data = JSON.parse(payload) as Record<string, unknown>;
    if (typeof data.delta === "string") return { delta: data.delta };
    if (typeof data.error === "string") return { error: data.error };
    const toolCall = data.tool_call as { name?: unknown } | undefined;
    if (toolCall && typeof toolCall.name === "string") {
      return { toolCall: toolCall.name };
    }
    if (data.tool_result !== undefined) return { toolResult: true };
    if (Array.isArray(data.rag_citations)) return { citations: data.rag_citations.length };
  } catch {
    // 忽略无法解析的帧
  }
  return null;
}

interface ChatRequest {
  baseUrl: string;
  question: string;
  sessionId: string;
  resources: {
    rag: { sources: string[]; topK: number };
    sqlSources?: string[];
    mcpTools?: ChatMcpToolBinding[];
  };
  /** 渠道所属工作区；透传给服务端 resolveWorkspace。 */
  workspaceId?: string;
  /** IM 来源标识（渠道/用户/会话类型），服务端据此给会话打 source='im'。 */
  im?: { channelId?: string; actor?: string; chatType?: string };
  signal?: AbortSignal;
}

/** 按 serviceSlug:toolName 去重，保留首次出现顺序。 */
function dedupeTools(tools: ChatMcpToolBinding[]): ChatMcpToolBinding[] {
  const unique = new Map<string, ChatMcpToolBinding>();
  for (const tool of tools) {
    const serviceSlug = tool.serviceSlug?.trim() ?? "";
    const toolName = tool.toolName?.trim() ?? "";
    if (!serviceSlug || !toolName) continue;
    unique.set(`${serviceSlug}:${toolName}`, { serviceSlug, toolName });
  }
  return [...unique.values()];
}

/** 发起一次 /api/chat 请求并聚合 SSE delta 与工具/引用计数。 */
async function requestChat(request: ChatRequest): Promise<ChatAnswer> {
  const { baseUrl, question, sessionId, resources, workspaceId, im, signal } = request;
  const headers: Record<string, string> = { "content-type": "application/json" };
  // 工作区归属：渠道配置的 workspace 决定会话与用量的归集空间。
  if (workspaceId) headers["x-workspace-id"] = workspaceId;
  // IM 来源标注（信任边界见 types.ts 的说明：只用于归属标注，不是强隔离）。
  if (im?.channelId) headers["x-im-channel"] = im.channelId;
  if (im?.actor) headers["x-im-actor"] = im.actor;
  if (im?.chatType) headers["x-im-chat-type"] = im.chatType;
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      messages: [{ role: "user", content: question }],
      sessionId,
      resources,
    }),
    signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`chat request failed (${response.status}): ${detail.slice(0, 200)}`);
  }
  if (!response.body) throw new Error("chat response body is empty");

  let content = "";
  let buffer = "";
  const toolCalls: string[] = [];
  let toolResultCount = 0;
  let citations = 0;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sepIndex: number;
    while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);
      const event = parseChatSseEvent(frame);
      if (!event) continue;
      if (event.error) throw new Error(event.error);
      if (event.delta) content += event.delta;
      if (event.toolCall) toolCalls.push(event.toolCall);
      if (event.toolResult) toolResultCount += 1;
      if (typeof event.citations === "number") citations += event.citations;
    }
  }

  return { content: content.trim(), toolCalls, toolResultCount, citations };
}

export async function askChat(params: {
  baseUrl: string;
  question: string;
  sessionId: string;
  sources: string[];
  topK: number;
  /** 绑定的 SQL 问数数据源；为空/缺省时不携带，保持旧请求体形状。 */
  sqlSources?: string[];
  /** 绑定的 MCP 工具；为空/缺省时不携带，保持旧请求体形状。 */
  mcpTools?: ChatMcpToolBinding[];
  /** 渠道所属工作区；透传为 x-workspace-id 头。 */
  workspaceId?: string;
  /** IM 来源标识（渠道/用户/会话类型），透传为 x-im-* 头。 */
  im?: { channelId?: string; actor?: string; chatType?: string };
  signal?: AbortSignal;
}): Promise<ChatAnswer> {
  const { baseUrl, question, sessionId, sources, topK, sqlSources, mcpTools, signal } = params;
  // 去重：同一 serviceSlug:toolName 只保留一次，避免重复声明同一工具。
  let activeTools = dedupeTools(mcpTools ?? []);
  let degraded = 0;

  for (;;) {
    const resources = {
      rag: { sources, topK },
      ...(sqlSources && sqlSources.length > 0 ? { sqlSources } : {}),
      ...(activeTools.length > 0 ? { mcpTools: activeTools } : {}),
    };
    try {
      return await requestChat({
        baseUrl,
        question,
        sessionId,
        resources,
        ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
        ...(params.im ? { im: params.im } : {}),
        signal,
      });
    } catch (error) {
      const missing = parseUnavailableTool(error);
      if (!missing || degraded >= MAX_MCP_DEGRADE_RETRIES) throw error;
      degraded += 1;
      activeTools = activeTools.filter(
        (tool) => !(tool.serviceSlug === missing.serviceSlug && tool.toolName === missing.toolName),
      );
      logTrace(
        "im.chat.mcp_tool_degraded",
        {
          serviceSlug: missing.serviceSlug,
          toolName: missing.toolName,
          remaining: activeTools.length,
        },
        "warn",
      );
    }
  }
}
