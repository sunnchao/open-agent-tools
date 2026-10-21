import { Router, type Request, type Response } from "express";
import { addMessage, ensureSession, updateMessage, type Role } from "../db.js";
import type { SqlQuestionSource } from "../function_tools/sqlQuestion.js";
import { listSchemaSources } from "../schemaSources/store.js";
import { getDefaultProvider, getProvider } from "../providers/store.js";
import { createLlmClient } from "../providers/clients/index.js";
import { normalizeResourceBindings, type McpToolBinding } from "../resources.js";
import { resolveWorkspace } from "../workspace.js";
import { logDebugDuration, logTrace, truncate } from "../trace.js";
import { runTraced, withTraceAttributes } from "@open-agent-tools/observability";
import { ChatTurnError, streamChatTurn, usageSnapshot, type ChatTurnUsage } from "./chatCore.js";

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
    ensureSession(resolvedSessionId, workspaceId);

    if (userMessage?.content) {
      addMessage(resolvedSessionId, {
        id: userMessage.id,
        role: "user",
        content: userMessage.content,
        status: "complete",
      });
    }

    const assistant = addMessage(resolvedSessionId, {
      role: "assistant",
      content: "",
      status: "streaming",
    });
    assistantMessageId = assistant?.id ?? null;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const send = (data: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  if (assistantMessageId) {
    send({ assistantMessageId });
  }

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
              onUsage: (usage) => { turnUsage = usage; },
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
    send({ done: true, status: outcome, ...(snapshot ? { usage: snapshot } : {}) });
    res.end();
  }
});
