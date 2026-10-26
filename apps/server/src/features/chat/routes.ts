import { Router, type Request, type Response } from "express";
import { addMessage, ensureSession, updateMessage, type Role } from "../../platform/db.js";
import type { SqlQuestionSource } from "../query/function-tools/sqlQuestion.js";
import { listSchemaSources } from "../query/schema/store.js";
import { getDefaultProvider, getProvider } from "../providers/store.js";
import { createLlmClient } from "../providers/clients/index.js";
import { normalizeResourceBindings, type McpToolBinding } from "../resources/catalog.js";
import { resolveWorkspace } from "../../platform/workspace/store.js";
import { logDebugDuration, logTrace, truncate } from "../../platform/trace.js";
import { runTraced, withTraceAttributes } from "@open-agent-tools/observability";
import { writeSseData } from "../../http/sse.js";
import { ChatTurnError, streamChatTurn, usageSnapshot, type ChatTurnUsage } from "./core.js";
import type { UsageModelDetail } from "../../platform/usage/tracking.js";
import type { ChatCompactReport } from "@open-agent-tools/studio-client";
import { IM_ACTOR_HEADER, IM_CHANNEL_HEADER, IM_CHAT_TYPE_HEADER } from "../im/types.js";
import { loadSessionHistory } from "../memory/history.js";
import { buildMemoryContext } from "../memory/recall.js";
import { parseImSessionScope } from "../memory/scope.js";
import { extractAndStoreMemory } from "../memory/extract.js";

/** 历史回读默认窗口（可被 CHAT_KEEP_RECENT_TURNS 之外的独立上限覆盖）。 */
const CHAT_HISTORY_TURNS = Number.parseInt(process.env.CHAT_HISTORY_TURNS ?? "", 10) || 20;
const CHAT_HISTORY_MAX_CHARS =
  Number.parseInt(process.env.CHAT_HISTORY_MAX_CHARS ?? "", 10) || 12_000;

export const chatRouter: ReturnType<typeof Router> = Router();

interface ChatRequestBody {
  messages?: Array<{ role: Role; content: string }>;
  model?: string;
  providerId?: string;
  sessionId?: string;
  userMessage?: { id?: string; content: string };
  resources?: {
    mcpTools?: McpToolBinding[];
    rag?: { sources?: string[]; topK?: number };
    sqlSources?: string[];
  };
}

chatRouter.post("/api/chat", async (req: Request, res: Response) => {
  const chatStartedAt = Date.now();
  const { messages, model, providerId, sessionId, userMessage, resources } =
    req.body as ChatRequestBody;

  if (!Array.isArray(messages) || messages.length === 0) {
    logTrace("chat.rejected", { reason: "messages must be a non-empty array" }, "warn");
    res.status(400).json({ error: "messages must be a non-empty array" });
    return;
  }

  for (const m of messages) {
    if (!["user", "assistant", "system", "tool"].includes(m.role)) {
      logTrace("chat.rejected", { reason: `invalid role: ${m.role}` }, "warn");
      res.status(400).json({ error: `invalid role: ${m.role}` });
      return;
    }
  }

  const selectedProvider = providerId
    ? getProvider(providerId, { requireEnabled: true })
    : getDefaultProvider({ requireEnabled: true });
  if (!selectedProvider) {
    res
      .status(400)
      .json({ error: providerId ? "provider not found" : "default provider is unavailable" });
    return;
  }
  if (!selectedProvider.apiKey) {
    const message = `Provider「${selectedProvider.name}」未配置 API Key，请在「设置」中为该 Provider 填写 API Key`;
    logTrace(
      "chat.provider_unavailable",
      { providerId: selectedProvider.id, error: message },
      "warn",
    );
    res.status(400).json({ error: message });
    return;
  }

  const llm = createLlmClient(selectedProvider);
  const selectedModel = model || selectedProvider.models[0] || "gpt-4o-mini";
  // 模型元数据随 SSE 下发：IM 审计据此记录"由哪个 Provider/模型回答"。
  const modelInfo = {
    providerId: selectedProvider.id,
    providerName: selectedProvider.name,
    providerFormat: selectedProvider.format,
    model: selectedModel,
  };

  let bindings: ReturnType<typeof normalizeResourceBindings>;
  try {
    bindings = normalizeResourceBindings(resources);
  } catch (error) {
    logTrace("chat.rejected", { reason: "invalid resources" }, "warn");
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    return;
  }

  const workspace = resolveWorkspace(req);
  if (!workspace.ok) {
    logTrace(
      "chat.rejected",
      { reason: "unknown workspace", requested: workspace.requested },
      "warn",
    );
    res.status(400).json({ error: `workspace not found: ${workspace.requested}` });
    return;
  }
  const workspaceId = workspace.workspaceId;

  const resolvedSessionId = sessionId;
  let assistantMessageId: string | null = null;
  let toolRounds = 0;
  let turnUsage: ChatTurnUsage | null = null;
  let turnModels: UsageModelDetail[] = [];
  let compactReport: ChatCompactReport | null = null;
  // 抽取所需的上下文：在 finally 里异步使用，必须活过 if 块。
  let imRequestScope = false;
  let lastUserQueryForMemory: string | null = null;

  const schemaSources: SqlQuestionSource[] =
    bindings.sqlSources.length > 0
      ? listSchemaSources()
          .filter((source) => bindings.sqlSources.includes(source.id))
          .map(({ id, name, connector }) => ({ id, name, connector }))
      : [];

  logTrace("chat.start", {
    sessionId: resolvedSessionId ?? null,
    messageCount: messages.length,
    providerId: selectedProvider.id,
    format: selectedProvider.format,
    model: selectedModel,
    ragSources: bindings.rag.sources.length,
    ragTopK: bindings.rag.topK,
    mcpToolBindings: bindings.mcpTools.length,
    sqlSources: bindings.sqlSources.join(",") || "(none)",
  });

  if (resolvedSessionId) {
    // IM 来源标注：请求头由本机 IM bot 注入。
    // 信任边界：Agent Server 当前没有用户隔离（README 已知局限），这些头只用于
    // **归属标注**（把会话标成 source='im' 并记录 actor/channel），不是强安全隔离。
    const imChannel = req.header(IM_CHANNEL_HEADER)?.trim();
    const imActor = req.header(IM_ACTOR_HEADER)?.trim();
    const imChatType = req.header(IM_CHAT_TYPE_HEADER)?.trim();
    const isImRequest = Boolean(imChannel);
    ensureSession(resolvedSessionId, workspaceId, {
      ...(isImRequest
        ? {
            source: "im" as const,
            actor: imActor || null,
            channelId: imChannel,
          }
        : {}),
    });

    // 用户轮必须落库：IM 只发当前一句话且不带 userMessage，此前用户问句会丢失。
    // 以 messages 里最后一条 user 为准（客户端可能已经带了自己的历史）。
    const lastUserContent = [...messages].reverse().find((m) => m.role === "user")?.content;
    const userContent = userMessage?.content ?? lastUserContent;
    lastUserQueryForMemory = userContent ?? null;
    imRequestScope = isImRequest;
    if (userContent?.trim()) {
      addMessage(resolvedSessionId, {
        ...(userMessage?.id ? { id: userMessage.id } : {}),
        role: "user",
        content: userContent,
        status: "complete",
      });
    }

    const assistant = addMessage(resolvedSessionId, {
      role: "assistant",
      content: "",
      status: "streaming",
    });
    assistantMessageId = assistant?.id ?? null;

    // 历史与记忆都以 DB 为准：客户端只用来定位本轮问题，避免长会话重复膨胀。
    const history = loadSessionHistory(resolvedSessionId, {
      turns: CHAT_HISTORY_TURNS,
      maxChars: CHAT_HISTORY_MAX_CHARS,
      ...(userMessage?.id ? { excludeMessageIds: [userMessage.id] } : {}),
    });
    const imScope = isImRequest
      ? parseImSessionScope(resolvedSessionId, imActor, imChatType ?? null)
      : null;
    const memoryContext = buildMemoryContext({
      workspaceId,
      ...(imScope?.personKey ? { personId: imScope.personKey } : {}),
      query: userContent ?? "",
    });

    // 顺序：系统提示 → 记忆 → 摘要 → 历史窗口 → 本轮问题。
    const rebuilt: Array<{ role: Role; content: string }> = [];
    if (memoryContext) rebuilt.push({ role: "system", content: memoryContext });
    if (history.summary) {
      rebuilt.push({
        role: "system",
        content: `## 会话摘要（早前对话）\n${history.summary}`,
      });
    }
    rebuilt.push(...history.turns);
    if (userContent?.trim()) rebuilt.push({ role: "user", content: userContent });
    messages.splice(0, messages.length, ...rebuilt);

    logTrace("chat.history", {
      sessionId: resolvedSessionId,
      turns: history.turns.length,
      omittedTurns: history.omittedTurns,
      hasSummary: Boolean(history.summary),
      memoryChars: memoryContext.length,
    });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const send = (data: Record<string, unknown>) => {
    writeSseData(res, data);
  };

  if (assistantMessageId) {
    send({ assistantMessageId });
  }
  // 先于生成下发模型信息：即使本轮后续失败，调用方（IM 审计）也能记录模型归属。
  send({ model: modelInfo });

  let fullContent = "";
  let outcome: "complete" | "error" = "complete";
  let errorMessage = "LLM request failed";
  try {
    const lastUserQuery = [...messages]
      .reverse()
      .find((message) => message.role === "user")?.content;
    await runTraced("chat-turn", async (span) => {
      span.update({
        input: lastUserQuery ?? null,
        metadata: {
          providerId: selectedProvider.id,
          model: selectedModel,
        },
      });

      await withTraceAttributes(
        {
          sessionId: resolvedSessionId ?? undefined,
          tags: ["chat"],
          metadata: {
            provider: selectedProvider.id,
            format: selectedProvider.format,
            model: selectedModel,
          },
          version: "0.0.0",
        },
        async () => {
          try {
            const result = await streamChatTurn({
              llm,
              model: selectedModel,
              providerId: selectedProvider.id,
              workspaceId,
              messages,
              bindings,
              resolvedSessionId,
              send,
              span,
              schemaSources,
              onUsage: (usage, models) => {
                turnUsage = usage;
                turnModels = models;
              },
              onCompact: (report) => {
                compactReport = report;
              },
            });
            fullContent = result.fullContent;
            toolRounds = result.toolRounds;
            turnUsage = result.usage;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            span.update({
              level: "ERROR",
              statusMessage: truncate(message, 300),
              metadata: {
                providerId: selectedProvider.id,
                model: selectedModel,
                sessionId: resolvedSessionId ?? "",
              },
            });
            throw error;
          }
        },
      );

      span.update({
        output: { content: fullContent },
        metadata: {
          providerId: selectedProvider.id,
          model: selectedModel,
          toolRounds: String(toolRounds),
        },
      });
    });
  } catch (error) {
    outcome = "error";
    if (error instanceof ChatTurnError && error.partialContent) fullContent = error.partialContent;
    errorMessage = error instanceof Error ? error.message : "LLM request failed";
    logTrace(
      "chat.error",
      {
        sessionId: resolvedSessionId ?? null,
        error: truncate(errorMessage, 300),
        durationMs: Date.now() - chatStartedAt,
      },
      "error",
    );
    send({ error: errorMessage });
  } finally {
    // 终态只写一次。失败时保留已生成内容，不能被无条件的 complete 覆盖。
    // { done: true } 无论成败都要发，否则客户端无法区分流是否结束。
    if (assistantMessageId) {
      updateMessage(assistantMessageId, {
        content: outcome === "error" ? fullContent || errorMessage : fullContent,
        status: outcome,
      });
    }
    const snapshot = turnUsage ? usageSnapshot(turnUsage) : null;
    logDebugDuration("chat.done", chatStartedAt, {
      sessionId: resolvedSessionId ?? null,
      toolRounds,
      contentLength: fullContent.length,
      status: outcome,
      totalTokens: snapshot?.totalTokens ?? 0,
    });

    // 事实抽取：仅成功轮、异步执行，失败只记 trace，绝不影响回复。
    if (
      resolvedSessionId &&
      outcome === "complete" &&
      fullContent.trim() &&
      process.env.MEMORY_EXTRACT !== "off"
    ) {
      const scope = imRequestScope
        ? parseImSessionScope(
            resolvedSessionId,
            req.header(IM_ACTOR_HEADER)?.trim(),
            req.header(IM_CHAT_TYPE_HEADER)?.trim(),
          )
        : null;
      void extractAndStoreMemory({
        llm,
        model: selectedModel,
        workspaceId,
        sessionId: resolvedSessionId,
        channelId: req.header(IM_CHANNEL_HEADER)?.trim() ?? null,
        personId: scope?.personKey ?? null,
        groupScopeKey: scope?.groupKey ?? null,
        question: lastUserQueryForMemory ?? "",
        answer: fullContent,
        actor: req.header(IM_ACTOR_HEADER)?.trim() ?? null,
      }).catch((error: unknown) => {
        logTrace("memory.extract_error", { error: truncate(String(error), 200) }, "warn");
      });
    }

    send({
      done: true,
      status: outcome,
      ...(snapshot ? { usage: snapshot } : {}),
      ...(turnModels.length > 0 ? { models: turnModels } : {}),
      ...(compactReport ? { compact: compactReport } : {}),
      model: modelInfo,
    });
    res.end();
  }
});
