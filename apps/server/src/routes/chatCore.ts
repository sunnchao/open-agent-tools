import { executeTool, tools as builtinTools } from "../function_tools/index.js";
import {
  buildSqlQuestionTools,
  sqlQuestionToolName,
  type SqlQuestionSource,
} from "../function_tools/sqlQuestion.js";
import type { HistoryTurn } from "../oneapiDemo/text2sql.js";
import { addMessage, type Role } from "../db.js";
import {
  type LlmClient,
  type LlmMessage,
  type LlmStreamResult,
  type LlmToolDefinition,
} from "../providers/clients/index.js";
import { callMcpTool, type normalizeResourceBindings, resolveMcpTools } from "../resources.js";
import { LlmRetrievalEvaluator, type RetrievalEvaluator } from "@open-agent-tools/rag/crag";
import { createChatCragController } from "../crag.js";
import { recordUsageEvent, type UsageEventInput, type UsageToolKind } from "../usage.js";
import { logDuration, logTrace, truncate } from "../trace.js";
import {
  startObservation,
  slimValue,
  type ObservationHandle,
} from "@open-agent-tools/observability";

// 启发式评估器无状态，跨请求复用同一控制器；LLM 评估器依赖每请求的 provider，单独构造。
let cragSingleton: ReturnType<typeof createChatCragController> | null = null;

export class ChatTurnError extends Error {
  constructor(
    message: string,
    readonly partialContent: string,
  ) {
    super(message);
    this.name = "ChatTurnError";
  }
}

export interface ChatStreamParams {
  llm: LlmClient;
  model: string;
  providerId: string;
  workspaceId: string;
  messages: Array<{ role: Role; content: string }>;
  bindings: ReturnType<typeof normalizeResourceBindings>;
  /** 发布应用调用方分组；缺省为管理侧，不启用文档 ACL。 */
  viewerGroups?: string[];
  resolvedSessionId: string | null | undefined;
  send: (data: Record<string, unknown>) => void;
  span: ObservationHandle;
  schemaSources: SqlQuestionSource[];
}

export interface ChatTurnUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** 累计触发的工具调用次数（含成功与失败）。 */
  toolCalls: number;
  toolErrors: number;
}

/**
 * 单轮 chat 的核心流式逻辑（RAG 检索 + MCP 工具解析 + 多轮 LLM 工具调用）。
 * 所有 LLM 调用（generation）、工具调用（tool）、检索（retriever）都会写入 Langfuse。
 */
export async function streamChatTurn(
  params: ChatStreamParams,
): Promise<{ fullContent: string; toolRounds: number; usage: ChatTurnUsage }> {
  const {
    llm,
    model,
    providerId,
    workspaceId,
    messages,
    bindings,
    viewerGroups,
    resolvedSessionId,
    send,
    schemaSources,
  } = params;
  let fullContent = "";
  let toolRounds = 0;
  let awaitingSqlClarification = false;
  const usage: ChatTurnUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    toolCalls: 0,
    toolErrors: 0,
  };

  // 历史会话中的 tool 行缺少 OpenAI 要求的 assistant tool_calls 上下文，统一丢弃。
  const completionMessages: LlmMessage[] = messages
    .filter((message) => message.role !== "tool")
    .map((message) => ({ role: message.role, content: message.content }));

  if (schemaSources.length > 0) {
    completionMessages.unshift({
      role: "system",
      content:
        "需要查询数据库时，调用对应数据源的 SQL 问数工具，提交自然语言问题。" +
        "保留用户明确提出的条件和条数；模块会自行检索 Schema、生成和校验 SQL，按结果汇总回答。" +
        "收到 clarifying 时原样向用户确认，等待用户补充后再调用；不要自行猜测条数或查询口径。" +
        "跨数据源问题分别调用各源工具后汇总，不要尝试跨源 JOIN。",
    });
  }
  const sqlHistory: HistoryTurn[] = messages
    .slice(0, Math.max(0, messages.map((message) => message.role).lastIndexOf("user")))
    .filter(
      (message): message is HistoryTurn => message.role === "user" || message.role === "assistant",
    )
    .slice(-6);

  const lastUserQuery = [...messages].reverse().find((message) => message.role === "user")?.content;

  if (bindings.rag.sources.length > 0 && lastUserQuery) {
    const ragStartedAt = Date.now();
    // CRAG 检索：块级检索 + 图谱子图检索 → 评估 → 纠正 → 条带精炼
    // CRAG_EVALUATOR=llm 时用 LLM 评估（更准，多一次小模型调用）；默认启发式（零成本）
    const useLlmEvaluator = process.env.CRAG_EVALUATOR === "llm" && llm;
    // 发布应用把调用方分组透传到检索服务；管理台不传，保持全量可见。
    const createController = (evaluator?: RetrievalEvaluator) =>
      viewerGroups !== undefined
        ? createChatCragController(evaluator, viewerGroups)
        : createChatCragController(evaluator);
    const crag = useLlmEvaluator
      ? createController(
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
                  statusMessage:
                    error instanceof Error ? truncate(error.message, 300) : String(error),
                });
                throw error;
              } finally {
                evaluatorObservation.end();
              }
            },
          }),
        )
      : viewerGroups !== undefined
        ? createController()
        : (cragSingleton ??= createController());

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
      throw new ChatTurnError(error instanceof Error ? error.message : String(error), fullContent);
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
  const sqlTools = buildSqlQuestionTools(schemaSources).map((tool) => ({
    name: tool.function.name,
    description: tool.function.description ?? "",
    parameters: tool.function.parameters as Record<string, unknown>,
  }));
  const completionTools: LlmToolDefinition[] = [
    ...builtinTools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description ?? "",
      parameters: tool.function.parameters as Record<string, unknown>,
    })),
    ...sqlTools,
    ...mcpTools.map((tool) => ({
      name: tool.definition.function.name,
      description: tool.definition.function.description ?? "",
      parameters: tool.definition.function.parameters as Record<string, unknown>,
    })),
  ];
  const sqlByName = new Map(
    schemaSources.map((source) => [sqlQuestionToolName(source.id), source]),
  );

  const maxToolRounds = 4;
  for (let round = 0; round <= maxToolRounds; round += 1) {
    const allowTools = round < maxToolRounds && !awaitingSqlClarification;
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
      throw new ChatTurnError(error instanceof Error ? error.message : String(error), fullContent);
    }

    const roundContent = result.content;
    if (result.tokenUsage) {
      usage.inputTokens += result.tokenUsage.inputTokens;
      usage.outputTokens += result.tokenUsage.outputTokens;
    }
    generation.update({
      output: { content: roundContent },
      ...(result.tokenUsage
        ? {
            usageDetails: {
              input: result.tokenUsage.inputTokens,
              output: result.tokenUsage.outputTokens,
            },
          }
        : {}),
    });
    generation.end();
    logDuration(`chat.llm.round${round}`, roundStartedAt, {
      allowTools,
      roundContentLength: roundContent.length,
      inputTokens: result.tokenUsage?.inputTokens,
      outputTokens: result.tokenUsage?.outputTokens,
    });
    // token 用量透出（P0-4）：每轮结束下发一次累计值，前端无需等 done 即可展示成本。
    if (result.tokenUsage) {
      send({ usage: usageSnapshot(usage) });
    }
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
      const sqlSource = sqlByName.get(call.name);
      const displayName = mcp
        ? `${mcp.serviceSlug}/${mcp.toolName}`
        : sqlSource
          ? `SQL 问数 · ${sqlSource.name}`
          : call.name;
      const kind: UsageToolKind = mcp ? "mcp" : sqlSource ? "sql" : "builtin";
      const usageEvent: UsageEventInput = {
        kind: "tool",
        workspaceId,
        sessionId: resolvedSessionId ?? null,
        providerId,
        model,
        toolKind: kind,
        toolName: displayName,
      };
      send({ tool_call: { id: call.id, name: displayName, arguments: call.arguments } });
      let toolContent: string;
      const toolStartedAt = Date.now();
      usage.toolCalls += 1;
      const toolObservation = startObservation(
        "call-tool",
        {
          input: {
            name: displayName,
            kind,
            arguments: slimValue(parseToolArguments(call.arguments)),
          },
        },
        { asType: "tool" },
      );
      try {
        const args = (call.arguments ? JSON.parse(call.arguments) : {}) as Record<string, unknown>;
        const result = mcp
          ? await callMcpTool(mcp, args)
          : await executeTool(call.name, call.arguments, { schemaSources, history: sqlHistory });
        toolContent = JSON.stringify(result) ?? "null";
        recordUsageEvent({
          ...usageEvent,
          durationMs: Date.now() - toolStartedAt,
          status: "ok",
        });
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
        if (
          sqlSource &&
          (ui as { props?: { clarifying?: string } } | undefined)?.props?.clarifying
        ) {
          awaitingSqlClarification = true;
        }
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
        usage.toolErrors += 1;
        recordUsageEvent({
          ...usageEvent,
          durationMs: Date.now() - toolStartedAt,
          status: "error",
        });
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

  return { fullContent, toolRounds, usage };
}

/** SSE 下发的用量快照（前端展示与成本对账共用同一口径）。 */
export function usageSnapshot(usage: ChatTurnUsage): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  toolCalls: number;
  toolErrors: number;
} {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.inputTokens + usage.outputTokens,
    toolCalls: usage.toolCalls,
    toolErrors: usage.toolErrors,
  };
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
