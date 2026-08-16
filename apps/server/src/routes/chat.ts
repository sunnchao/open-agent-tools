import { Router, type Request, type Response } from "express";
import { addMessage, ensureSession, updateMessage, type Role } from "../db.js";
import { executeTool, tools as builtinTools } from "../function_tools/index.js";
import { buildSchemaInjection } from "../schema-inject.js";
import { getDefaultProvider, getProvider } from "../providers/store.js";
import {
  createLlmClient,
  type LlmClient,
  type LlmMessage,
  type LlmStreamResult,
  type LlmToolDefinition,
} from "../providers/clients/index.js";
import {
  callMcpTool,
  normalizeResourceBindings,
  resolveMcpTools,
  type McpToolBinding,
} from "../resources.js";
import { LlmRetrievalEvaluator } from "@open-agent-tools/rag/crag";
import { createChatCragController } from "../crag.js";
import { logDuration, logTrace, truncate } from "../trace.js";
import {
  runTraced,
  startObservation,
  withTraceAttributes,
  slimValue,
  type ObservationHandle,
} from "@open-agent-tools/observability";

export const chatRouter: ReturnType<typeof Router> = Router();

// 启发式评估器无状态，跨请求复用同一控制器；LLM 评估器依赖每请求的 provider，单独构造。
let cragSingleton: ReturnType<typeof createChatCragController> | null = null;

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

interface ChatStreamParams {
  llm: LlmClient;
  model: string;
  messages: Array<{ role: Role; content: string }>;
  bindings: ReturnType<typeof normalizeResourceBindings>;
  resolvedSessionId: string | null | undefined;
  send: (data: Record<string, unknown>) => void;
  span: ObservationHandle;
  /** 渐进式 schema 注入（enriched catalog → 骨架 + 相关表）。 */
  schemaInjection: ReturnType<typeof buildSchemaInjection>;
}

/**
 * 单轮 chat 的核心流式逻辑（RAG 检索 + MCP 工具解析 + 多轮 LLM 工具调用）。
 * 所有 LLM 调用（generation）、工具调用（tool）、检索（retriever）都会写入 Langfuse。
 */
async function streamChatTurn(params: ChatStreamParams): Promise<{ fullContent: string; toolRounds: number }> {
  const { llm, model, messages, bindings, resolvedSessionId, send, schemaInjection } = params;
  let fullContent = "";
  let toolRounds = 0;

  // 历史会话中的 tool 行缺少 OpenAI 要求的 assistant tool_calls 上下文，统一丢弃。
  const completionMessages: LlmMessage[] = messages
    .filter((message) => message.role !== "tool")
    .map((message) => ({ role: message.role, content: message.content }));

  if (schemaInjection.enabled) {
    const schemaSystem =
      "你是 NEW-API 运营数据查询助手。可基于以下数据库 schema 生成只读 SQL，并调用 query_sql 工具执行获取数据。\n" +
      "规则：1) 表名/列名用反引号包裹；2) 时间戳是 Unix 秒；3) 大表必须带 WHERE 过滤；4) 中文问日期先换算 Unix 秒区间；5) 结果按用户语言汇总成自然语言回答。\n\n" +
      schemaInjection.skeleton +
      (schemaInjection.selected ? `\n\n${schemaInjection.selected}` : "");
    completionMessages.unshift({ role: "system", content: schemaSystem });
  }

  const lastUserQuery = [...messages]
    .reverse()
    .find((message) => message.role === "user")?.content;

  if (bindings.rag.sources.length > 0 && lastUserQuery) {
    const ragStartedAt = Date.now();
    // CRAG 检索：块级检索 + 图谱子图检索 → 评估 → 纠正 → 条带精炼
    // CRAG_EVALUATOR=llm 时用 LLM 评估（更准，多一次小模型调用）；默认启发式（零成本）
    const useLlmEvaluator = process.env.CRAG_EVALUATOR === "llm" && llm;
    const crag = useLlmEvaluator
      ? createChatCragController(
          new LlmRetrievalEvaluator({
            chat: async (system, user) => {
              const evaluatorObservation = startObservation(
                "evaluate-relevance",
                { model, input: { system, user: slimValue(user, 1500) } },
                { asType: "generation" },
              );
              try {
                const resp = await llm.complete({
                  model,
                  messages: [
                    { role: "system", content: system },
                    { role: "user", content: user },
                  ],
                });
                evaluatorObservation.update({
                  output: { content: resp.content },
                  ...(resp.tokenUsage
                    ? {
                        usageDetails: {
                          input: resp.tokenUsage.inputTokens,
                          output: resp.tokenUsage.outputTokens,
                        },
                      }
                    : {}),
                });
                return resp.content;
              } catch (error) {
                evaluatorObservation.update({
                  level: "ERROR",
                  statusMessage: error instanceof Error ? truncate(error.message, 300) : String(error),
                });
                throw error;
              } finally {
                evaluatorObservation.end();
              }
            },
          }),
        )
      : (cragSingleton ??= createChatCragController());

    const ragObservation = startObservation(
      "retrieve-context",
      {
        input: { query: lastUserQuery, sources: bindings.rag.sources, topK: bindings.rag.topK },
      },
      { asType: "retriever" },
    );
    try {
      const result = await crag.retrieve(lastUserQuery, { sources: bindings.rag.sources });
      logDuration("chat.rag", ragStartedAt, {
        sources: bindings.rag.sources.length,
        topK: bindings.rag.topK,
        assessment: result.assessment,
        confidence: result.confidence,
        actions: result.actions.join(","),
        query: truncate(lastUserQuery, 120),
      });
      ragObservation.update({
        output: {
          assessment: result.assessment,
          confidence: result.confidence,
          actions: result.actions.join(","),
          citations: result.citations.length,
        },
        metadata: {
          query: truncate(lastUserQuery, 120),
          sources: bindings.rag.sources.join(","),
          topK: String(bindings.rag.topK),
        },
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
    } catch (error) {
      ragObservation.update({
        level: "ERROR",
        statusMessage: error instanceof Error ? truncate(error.message, 300) : String(error),
      });
      throw error;
    } finally {
      ragObservation.end();
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
    const generation = startObservation(
      "generate-response",
      {
        model,
        input: completionMessages,
        metadata: { round: String(round), allowTools: String(allowTools) },
      },
      { asType: "generation" },
    );
    let result: LlmStreamResult;
    try {
      result = await llm.streamChat({
        model,
        messages: completionMessages,
        ...(allowTools ? { tools: completionTools } : {}),
        callbacks: {
          onDelta: (delta) => {
            fullContent += delta;
            send({ delta });
          },
        },
      });
    } catch (error) {
      generation.update({
        level: "ERROR",
        statusMessage: error instanceof Error ? truncate(error.message, 300) : String(error),
      });
      generation.end();
      throw error;
    }

    const roundContent = result.content;
    generation.update({
      output: { content: roundContent },
      ...(result.tokenUsage
        ? { usageDetails: { input: result.tokenUsage.inputTokens, output: result.tokenUsage.outputTokens } }
        : {}),
    });
    generation.end();
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
      const toolObservation = startObservation(
        "call-tool",
        {
          input: { name: displayName, kind, arguments: slimValue(parseToolArguments(call.arguments)) },
        },
        { asType: "tool" },
      );
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
        toolObservation.update({ output: { result: slimValue(result) } });
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
        toolObservation.update({
          level: "ERROR",
          statusMessage: truncate(message, 200),
        });
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
      } finally {
        toolObservation.end();
      }
      completionMessages.push({
        role: "tool",
        tool_call_id: call.id,
        content: toolContent,
      });
    }
  }

  return { fullContent, toolRounds };
}

/** 解析工具参数 JSON，解析失败时原样返回（避免 trace 写入报错）。 */
function parseToolArguments(argumentsValue: string): unknown {
  if (!argumentsValue) return {};
  try {
    return JSON.parse(argumentsValue);
  } catch {
    return argumentsValue;
  }
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
    const lastUserQuery = [...messages]
      .reverse()
      .find((message) => message.role === "user")?.content;
    const schemaInjection = buildSchemaInjection(lastUserQuery);
    if (schemaInjection.enabled) {
      logTrace("chat.schema", {
        sessionId: resolvedSessionId ?? null,
        tables: schemaInjection.tableNames.join(",") || "(skeleton only)",
        estimatedTokens: schemaInjection.estimatedTokens,
      });
    }

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
              messages,
              bindings,
              resolvedSessionId,
              send,
              span,
              schemaInjection,
            });
            fullContent = result.fullContent;
            toolRounds = result.toolRounds;
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
    // 结束标志：前端依赖 { done: true } 结束 loading 并解锁下一次对话。
    // 无论成功还是失败都必须发送，否则客户端无法区分流是否结束。
    if (assistantMessageId) {
      updateMessage(assistantMessageId, {
        content: fullContent,
        status: "complete",
      });
    }
    send({ done: true });
    res.end();
  }
});
