/**
 * 调用本服务 /api/chat 完成一轮知识库问答。
 *
 * 复用平台完整的 Agent Chat 链路（Provider 解析、CRAG 混合检索、工具轮次），
 * 通过 SSE 收集 delta 增量拼出最终文本。返回空串表示无回答。
 */

import { logTrace } from "../trace.js";

/** 一轮问答的 token 用量（服务端 `usage` 帧）。 */
export interface ChatUsage {
  /** 模型调用次数（不是对话轮次）。 */
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  toolCalls: number;
  toolErrors: number;
}

/** 单个模型的用量明细（服务端 `models` 帧，含嵌套 SQL 等子链路）。 */
export interface ChatModelUsage {
  providerId: string;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
  failed: boolean;
}

/** 本轮实际使用的 Provider / 模型（服务端 `model` 帧）。 */
export interface ChatModelInfo {
  providerId: string;
  providerName: string;
  providerFormat: string;
  model: string;
}

export interface ChatAnswer {
  content: string;
  /** 本轮触发的工具名（按出现顺序去重前的原始列表）。 */
  toolCalls: string[];
  /** 本轮返回的工具结果条数。 */
  toolResultCount: number;
  /** 本轮引用的知识片段数。 */
  citations: number;
  /** 本轮 token 用量；服务端未上报时为 null。 */
  usage?: ChatUsage | null;
  /** 逐模型用量明细；服务端未上报时为空数组。 */
  models?: ChatModelUsage[];
  /** 本轮实际使用的 Provider / 模型；服务端未上报时为 null。 */
  model?: ChatModelInfo | null;
}

/**
 * `/api/chat` 流内错误：附带出错前已累计的回答与用量。
 *
 * IM 审计在失败路径据此记录 token / 模型，而不是把用量丢成 0。
 */
export class ChatRequestError extends Error {
  constructor(
    message: string,
    readonly partial?: Partial<ChatAnswer>,
  ) {
    super(message);
    this.name = "ChatRequestError";
  }
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
 * 返回 delta 增量 / error / 检索评估 / 工具调用与引用计数；非数据帧与坏帧返回 null。
 * 未知事件（如 done、usage、assistantMessageId）一律忽略，向后兼容旧服务端。
 */
export interface ChatSseEvent {
  delta?: string;
  error?: string;
  /** 收到知识库检索评估（crag_assessment）帧。 */
  assessment?: boolean;
  /** 工具名。 */
  toolCall?: string;
  /** 工具结果条数（每次 tool_result 事件 +1）。 */
  toolResult?: boolean;
  /** tool_result 帧里回显的工具展示名；缺失时为 null。 */
  toolResultName?: string | null;
  /** 引用片段数（rag_citations 数组长度）。 */
  citations?: number;
  /** 本轮累计 token 用量（usage 帧）。 */
  usage?: ChatUsage;
  /** 逐模型用量明细（usage/models 帧）。 */
  models?: ChatModelUsage[];
  /** 本轮 Provider / 模型信息（model 帧）。 */
  model?: ChatModelInfo;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** 归一化服务端 `usage` 对象；非对象返回 null。 */
export function parseChatUsage(raw: unknown): ChatUsage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const data = raw as Record<string, unknown>;
  const inputTokens = nonNegativeInteger(data.inputTokens);
  const outputTokens = nonNegativeInteger(data.outputTokens);
  return {
    requests: nonNegativeInteger(data.requests),
    inputTokens,
    outputTokens,
    totalTokens: nonNegativeInteger(data.totalTokens) || inputTokens + outputTokens,
    toolCalls: nonNegativeInteger(data.toolCalls),
    toolErrors: nonNegativeInteger(data.toolErrors),
  };
}

/** 归一化服务端 `models` 数组；缺失/非法条目丢弃。 */
export function parseChatModels(raw: unknown): ChatModelUsage[] {
  if (!Array.isArray(raw)) return [];
  const models: ChatModelUsage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const data = item as Record<string, unknown>;
    const providerId = nonEmptyString(data.providerId) ?? "";
    const model = nonEmptyString(data.model) ?? "";
    if (!providerId && !model) continue;
    const inputTokens = nonNegativeInteger(data.inputTokens);
    const outputTokens = nonNegativeInteger(data.outputTokens);
    models.push({
      providerId,
      model,
      requests: nonNegativeInteger(data.requests),
      inputTokens,
      outputTokens,
      totalTokens: nonNegativeInteger(data.totalTokens) || inputTokens + outputTokens,
      durationMs: nonNegativeInteger(data.durationMs),
      failed: data.failed === true,
    });
  }
  return models;
}

/** 归一化服务端 `model` 对象；缺失/非法返回 null。 */
export function parseChatModelInfo(raw: unknown): ChatModelInfo | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const data = raw as Record<string, unknown>;
  const providerId = nonEmptyString(data.providerId);
  const model = nonEmptyString(data.model);
  if (!providerId && !model) return null;
  return {
    providerId: providerId ?? "",
    providerName: nonEmptyString(data.providerName) ?? "",
    providerFormat: nonEmptyString(data.providerFormat) ?? "",
    model: model ?? "",
  };
}

/** IM 等待期进度事件：answerMessage 据此发送阶段状态，失败时汇总已完成步骤。 */
export type ChatProgressEvent =
  | { type: "retrieval" }
  | { type: "citations"; count: number }
  | { type: "tool_call"; toolName: string }
  | { type: "tool_result"; toolName: string | null }
  | { type: "delta" };

export type ChatProgressHandler = (event: ChatProgressEvent) => void | Promise<void>;

export function parseChatSseEvent(line: string): ChatSseEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const payload = trimmed.slice(5).trim();
  if (!payload) return null;
  try {
    const data = JSON.parse(payload) as Record<string, unknown>;
    if (typeof data.delta === "string") return { delta: data.delta };
    if (typeof data.error === "string") return { error: data.error };
    if (data.crag_assessment !== undefined) return { assessment: true };
    const toolCall = data.tool_call as { name?: unknown } | undefined;
    if (toolCall && typeof toolCall.name === "string") {
      return { toolCall: toolCall.name };
    }
    if (data.tool_result !== undefined) {
      const result = data.tool_result as { name?: unknown } | undefined;
      const toolResultName = result && typeof result.name === "string" ? result.name : null;
      return { toolResult: true, toolResultName };
    }
    if (Array.isArray(data.rag_citations)) return { citations: data.rag_citations.length };
    // usage 帧可能同时带 models；done 帧则 usage + models + model 一起下发。
    const usage = parseChatUsage(data.usage);
    if (usage) {
      const models = parseChatModels(data.models);
      const model = parseChatModelInfo(data.model);
      return {
        usage,
        ...(models.length > 0 ? { models } : {}),
        ...(model ? { model } : {}),
      };
    }
    const model = parseChatModelInfo(data.model);
    if (model) return { model };
  } catch {
    // 忽略无法解析的帧
  }
  return null;
}

interface ChatRequest {
  baseUrl: string;
  question: string;
  sessionId: string;
  /** 账号级模型绑定；仅 Provider 与模型同时存在时写入请求体。 */
  providerId?: string;
  model?: string;
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
  /** 流式进度回调：检索/工具/首个 delta 到达时触发，用于 IM 等待期状态提示。 */
  onProgress?: ChatProgressHandler;
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
  const {
    baseUrl,
    question,
    sessionId,
    providerId: requestProviderId,
    model: requestModel,
    resources,
    workspaceId,
    im,
    signal,
    onProgress,
  } = request;
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
      ...(requestProviderId && requestModel
        ? { providerId: requestProviderId, model: requestModel }
        : {}),
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
  let deltaNotified = false;
  let usage: ChatUsage | null = null;
  let models: ChatModelUsage[] = [];
  let model: ChatModelInfo | null = null;
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
      if (event.error) {
        // 带上已累计的内容与用量：失败审计仍能记录本轮已消耗的 token / 模型。
        throw new ChatRequestError(event.error, {
          content: content.trim(),
          toolCalls: [...toolCalls],
          toolResultCount,
          citations,
          usage,
          models,
          model,
        });
      }
      if (event.model) model = event.model;
      if (event.usage) usage = event.usage;
      if (event.models) models = event.models;
      if (event.assessment) {
        await onProgress?.({ type: "retrieval" });
      }
      if (event.delta) {
        content += event.delta;
        if (!deltaNotified) {
          deltaNotified = true;
          await onProgress?.({ type: "delta" });
        }
      }
      if (event.toolCall) {
        toolCalls.push(event.toolCall);
        await onProgress?.({ type: "tool_call", toolName: event.toolCall });
      }
      if (event.toolResult) {
        toolResultCount += 1;
        await onProgress?.({ type: "tool_result", toolName: event.toolResultName ?? null });
      }
      if (typeof event.citations === "number") {
        citations += event.citations;
        if (event.citations > 0) await onProgress?.({ type: "citations", count: event.citations });
      }
    }
  }

  return { content: content.trim(), toolCalls, toolResultCount, citations, usage, models, model };
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
  /** 账号绑定的 Provider / 模型；缺省时服务端使用系统默认。 */
  providerId?: string;
  model?: string;
  /** IM 来源标识（渠道/用户/会话类型），透传为 x-im-* 头。 */
  im?: { channelId?: string; actor?: string; chatType?: string };
  signal?: AbortSignal;
  /** 流式进度回调：检索/工具/首个 delta 到达时触发，用于 IM 等待期状态提示。 */
  onProgress?: ChatProgressHandler;
}): Promise<ChatAnswer> {
  const {
    baseUrl,
    question,
    sessionId,
    sources,
    topK,
    sqlSources,
    mcpTools,
    providerId,
    model,
    signal,
    onProgress,
  } = params;
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
        ...(providerId && model ? { providerId, model } : {}),
        resources,
        ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
        ...(params.im ? { im: params.im } : {}),
        signal,
        ...(onProgress ? { onProgress } : {}),
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
