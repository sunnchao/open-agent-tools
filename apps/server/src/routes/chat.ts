import { Router, type Request, type Response } from "express";
import { addMessage, ensureSession, updateMessage, type Role } from "../db.js";
import { executeTool, tools as builtinTools } from "../function_tools/index.js";
import { getDefaultProvider, getProvider } from "../providers/store.js";
import {
  createLlmClient,
  type LlmMessage,
  type LlmToolDefinition,
} from "../providers/clients/index.js";
import {
  callMcpTool,
  normalizeResourceBindings,
  resolveMcpTools,
  type McpToolBinding,
} from "../resources.js";
import { createChatCragController } from "../crag.js";
import { logDuration, logTrace, truncate } from "../trace.js";

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

  const resolvedSessionId = sessionId;
  let assistantMessageId: string | null = null;
  let toolRounds = 0;
  logTrace("chat.start", {
    sessionId: resolvedSessionId ?? null,
    messageCount: messages.length,
    providerId: selectedProvider.id,
    format: selectedProvider.format,
    model: selectedModel,
    ragSources: bindings.rag.sources.length,
    ragTopK: bindings.rag.topK,
    mcpToolBindings: bindings.mcpTools.length,
  });

  if (resolvedSessionId) {
    ensureSession(resolvedSessionId);

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
  try {
    // 历史会话中的 tool 行缺少 OpenAI 要求的 assistant tool_calls 上下文，统一丢弃。
    const completionMessages: LlmMessage[] = messages
      .filter((message) => message.role !== "tool")
      .map((message) => ({ role: message.role, content: message.content }));

    const lastUserQuery = [...messages]
      .reverse()
      .find((message) => message.role === "user")?.content;
    if (bindings.rag.sources.length > 0 && lastUserQuery) {
      const ragStartedAt = Date.now();
      // CRAG 检索：块级检索 + 图谱子图检索 → 评估 → 纠正 → 条带精炼
      const crag = createChatCragController();
      const result = await crag.retrieve(lastUserQuery, { sources: bindings.rag.sources });
      logDuration("chat.rag", ragStartedAt, {
        sources: bindings.rag.sources.length,
        topK: bindings.rag.topK,
        assessment: result.assessment,
        confidence: result.confidence,
        actions: result.actions.join(","),
        query: truncate(lastUserQuery, 120),
      });
      send({
        crag_assessment: {
          assessment: result.assessment,
          confidence: result.confidence,
          actions: result.actions,
        },
      });
      send({
        rag_citations: result.citations.map((s) => ({
          source: s.source,
          chunkIndex: s.chunkIndex,
          content: s.text,
        })),
      });
      if (result.formatted) {
        completionMessages.unshift({
          role: "system",
          content:
            "优先基于以下挂载文档回答，并用【来源】标注引用；资料未覆盖时如实说明。\n\n" +
            result.formatted,
        });
      } else if (result.assessment === "incorrect") {
        // 评估为不相关且纠正失败：不注入噪声上下文，模型将如实说明
        completionMessages.unshift({
          role: "system",
          content:
            "已检索挂载文档但未找到与问题相关的资料。请如实告知用户知识库未覆盖该内容，不要编造。",
        });
      }
    }

    const mcpResolveStartedAt = Date.now();
    const mcpTools = await resolveMcpTools(bindings.mcpTools);
    logDuration("chat.mcp.resolve", mcpResolveStartedAt, {
      bindings: bindings.mcpTools.length,
      resolved: mcpTools.length,
    });
    const mcpByAlias = new Map(mcpTools.map((tool) => [tool.alias, tool]));
    const completionTools: LlmToolDefinition[] = [
      ...builtinTools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description ?? "",
        parameters: tool.function.parameters as Record<string, unknown>,
      })),
      ...mcpTools.map((tool) => ({
        name: tool.definition.function.name,
        description: tool.definition.function.description ?? "",
        parameters: tool.definition.function.parameters as Record<string, unknown>,
      })),
    ];

    const maxToolRounds = 4;
    for (let round = 0; round <= maxToolRounds; round += 1) {
      const allowTools = round < maxToolRounds;
      const roundStartedAt = Date.now();
      const result = await llm.streamChat({
        model: selectedModel,
        messages: completionMessages,
        ...(allowTools ? { tools: completionTools } : {}),
        callbacks: {
          onDelta: (delta) => {
            fullContent += delta;
            send({ delta });
          },
        },
      });

      const roundContent = result.content;
      logDuration(`chat.llm.round${round}`, roundStartedAt, {
        allowTools,
        roundContentLength: roundContent.length,
      });
      if (!allowTools) break;

      const calls = result.toolCalls.map((call, index) => ({
        ...call,
        id: call.id ?? `call_${round}_${index}`,
      }));
      if (calls.length === 0) break;
      toolRounds += 1;

      completionMessages.push({
        role: "assistant",
        content: roundContent,
        tool_calls: calls.map((call) => ({
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        })),
      });

      for (const call of calls) {
        const mcp = mcpByAlias.get(call.name);
        const displayName = mcp ? `${mcp.serviceSlug}/${mcp.toolName}` : call.name;
        const kind = mcp ? "mcp" : "builtin";
        send({ tool_call: { id: call.id, name: displayName, arguments: call.arguments } });
        let toolContent: string;
        const toolStartedAt = Date.now();
        try {
          const args = (call.arguments ? JSON.parse(call.arguments) : {}) as Record<
            string,
            unknown
          >;
          const result = mcp
            ? await callMcpTool(mcp, args)
            : await executeTool(call.name, call.arguments);
          toolContent = JSON.stringify(result) ?? "null";
          logDuration("chat.tool", toolStartedAt, {
            tool: displayName,
            kind,
            status: "ok",
          });
          const ui =
            result && typeof result === "object" && "ui" in result
              ? (result as { ui?: unknown }).ui
              : undefined;
          send({
            tool_result: {
              id: call.id,
              name: displayName,
              ...(ui === undefined ? { result } : { ui }),
            },
          });
          if (resolvedSessionId) {
            addMessage(resolvedSessionId, {
              role: "tool",
              content: toolContent,
              tool_call_id: call.id,
              tool_name: displayName,
              status: "complete",
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          toolContent = JSON.stringify({ error: message });
          logTrace(
            "chat.tool",
            {
              tool: displayName,
              kind,
              status: "error",
              durationMs: Date.now() - toolStartedAt,
              error: truncate(message, 200),
            },
            "error",
          );
          send({ tool_result: { id: call.id, name: displayName, error: message } });
          if (resolvedSessionId) {
            addMessage(resolvedSessionId, {
              role: "tool",
              content: toolContent,
              tool_call_id: call.id,
              tool_name: displayName,
              status: "error",
            });
          }
        }
        completionMessages.push({
          role: "tool",
          tool_call_id: call.id,
          content: toolContent,
        });
      }
    }

    if (assistantMessageId) {
      updateMessage(assistantMessageId, { content: fullContent, status: "complete" });
    }

    logDuration("chat.done", chatStartedAt, {
      sessionId: resolvedSessionId ?? null,
      contentLength: fullContent.length,
      toolRounds,
    });

    send({ done: true, assistantMessageId: assistantMessageId ?? undefined });
  } catch (error) {
    const message = error instanceof Error ? error.message : "LLM request failed";
    logTrace(
      "chat.error",
      {
        sessionId: resolvedSessionId ?? null,
        error: truncate(message, 300),
        durationMs: Date.now() - chatStartedAt,
      },
      "error",
    );
    if (assistantMessageId) {
      updateMessage(assistantMessageId, {
        content: fullContent || message,
        status: "error",
      });
    }
    send({ error: message });
  } finally {
    res.end();
  }
});
