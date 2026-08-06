import { config as loadEnv } from "dotenv";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions";
import { resolve } from "node:path";
import {
  addMessage,
  createSession,
  deleteMessage,
  deleteSession,
  ensureSession,
  getDbPath,
  getSession,
  listSessionsWithMessages,
  openDb,
  renameSession,
  updateMessage,
  type Role,
} from "./db.js";
import { executeTool, tools } from "./function_tools/index.js";
import {
  createProvider,
  createProviderClient,
  deleteProvider,
  fetchProviderModels,
  getProvider,
  initializeProviders,
  listProviders,
  updateProvider,
} from "./providers/store.js";
import {
  callMcpTool,
  loadResourceCatalog,
  normalizeResourceBindings,
  resolveMcpTools,
  retrieveRag,
  type McpToolBinding,
} from "./resources.js";
import { logDuration, logTrace, truncate } from "./trace.js";
import {
  executeWorkflowNodeTest,
  executeWorkflow,
  validateWorkflow,
  WorkflowNodeError,
  WorkflowValidationError,
  type WorkflowEvent,
  type WorkflowNodeTestRequest,
  type WorkflowRunRequest,
} from "./workflow/executor.js";

loadEnv({ path: resolve(import.meta.dirname, "../.env") });
loadEnv({ path: resolve(import.meta.dirname, "../.env.local"), override: true });

const app: express.Express = express();
const port = Number(process.env.PORT) || 3000;

const webOrigin = process.env.WEB_ORIGIN || "http://localhost:5173";

openDb();
initializeProviders();

app.use(cors({ origin: webOrigin }));
app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => {
  console.log("Time", Date.now());
  next();
});

// 请求级 trace:所有端点进出、状态码与耗时(health 探活静默,避免刷屏)
app.use((req: Request, res: Response, next: NextFunction) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    const isHealth = req.path === "/health" && res.statusCode < 400;
    if (isHealth) return;
    logTrace(
      "http.request",
      {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      },
      res.statusCode >= 400 ? "warn" : "info",
    );
  });
  next();
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

app.get("/api/resources", async (_req: Request, res: Response) => {
  const startedAt = Date.now();
  try {
    const catalog = await loadResourceCatalog();
    logDuration("resources.loaded", startedAt, {
      mcpConfigured: catalog.mcp.configured,
      mcpServices: catalog.mcp.services.length,
      ragSources: catalog.rag.sources.length,
      ...(catalog.mcp.error ? { mcpError: truncate(catalog.mcp.error, 200) } : {}),
      ...(catalog.rag.error ? { ragError: truncate(catalog.rag.error, 200) } : {}),
    });
    res.json(catalog);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logTrace("resources.error", { error: truncate(message, 200) }, "error");
    res.status(500).json({ error: message });
  }
});

app.get("/api/sessions", (_req: Request, res: Response) => {
  const sessions = listSessionsWithMessages();
  logTrace("sessions.list", { count: sessions.length });
  res.json({ sessions });
});

app.post("/api/sessions", (req: Request, res: Response) => {
  const body = req.body as { id?: string; title?: string } | undefined;
  const session = createSession({
    id: typeof body?.id === "string" ? body.id : undefined,
    title: typeof body?.title === "string" ? body.title : undefined,
  });
  logTrace("session.created", { sessionId: session.id });
  res.status(201).json({ session });
});

app.get("/api/sessions/:id", (req: Request, res: Response) => {
  const session = getSession(req.params.id as string);
  if (!session) {
    logTrace("session.not_found", { sessionId: req.params.id }, "warn");
    res.status(404).json({ error: "session not found" });
    return;
  }
  logTrace("session.loaded", { sessionId: session.id, messages: session.messages.length });
  res.json({ session });
});

app.patch("/api/sessions/:id", (req: Request, res: Response) => {
  const { title } = req.body as { title?: string };
  if (typeof title !== "string" || !title.trim()) {
    logTrace("session.rename_rejected", { reason: "title is required" }, "warn");
    res.status(400).json({ error: "title is required" });
    return;
  }
  const session = renameSession(req.params.id as string, title.trim());
  if (!session) {
    logTrace("session.not_found", { sessionId: req.params.id }, "warn");
    res.status(404).json({ error: "session not found" });
    return;
  }
  logTrace("session.renamed", { sessionId: session.id });
  res.json({ session });
});

app.delete("/api/sessions/:id", (req: Request, res: Response) => {
  const ok = deleteSession(req.params.id as string);
  if (!ok) {
    logTrace("session.not_found", { sessionId: req.params.id }, "warn");
    res.status(404).json({ error: "session not found" });
    return;
  }
  logTrace("session.deleted", { sessionId: req.params.id });
  res.status(204).end();
});

app.delete("/api/messages/:id", (req: Request, res: Response) => {
  const ok = deleteMessage(req.params.id as string);
  if (!ok) {
    logTrace("message.not_found", { messageId: req.params.id }, "warn");
    res.status(404).json({ error: "message not found" });
    return;
  }
  logTrace("message.deleted", { messageId: req.params.id });
  res.status(204).end();
});

function providerPayload(body: unknown): {
  name: string;
  baseUrl: string;
  apiKey?: string;
  models: string[];
  enabled?: boolean;
} {
  const value = body as Record<string, unknown> | undefined;
  return {
    name: typeof value?.name === "string" ? value.name : "",
    baseUrl: typeof value?.baseUrl === "string" ? value.baseUrl : "",
    ...(typeof value?.apiKey === "string" ? { apiKey: value.apiKey } : {}),
    models: Array.isArray(value?.models)
      ? value.models.filter((item): item is string => typeof item === "string")
      : [],
    ...(typeof value?.enabled === "boolean" ? { enabled: value.enabled } : {}),
  };
}

app.get("/api/providers", (_req: Request, res: Response) => {
  res.json({ providers: listProviders({ includeDisabled: true }) });
});

app.get("/api/admin/providers", (_req: Request, res: Response) => {
  res.json({ providers: listProviders({ includeDisabled: true }) });
});

app.post("/api/admin/providers", (req: Request, res: Response) => {
  try {
    res.status(201).json({ provider: createProvider(providerPayload(req.body)) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.put("/api/admin/providers/:id", (req: Request, res: Response) => {
  try {
    const provider = updateProvider(req.params.id as string, providerPayload(req.body));
    if (!provider) {
      res.status(404).json({ error: "provider not found" });
      return;
    }
    res.json({ provider });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete("/api/admin/providers/:id", (req: Request, res: Response) => {
  const result = deleteProvider(req.params.id as string);
  if (result === "not_found") {
    res.status(404).json({ error: "provider not found" });
    return;
  }
  if (result === "default") {
    res.status(409).json({ error: "default provider cannot be deleted" });
    return;
  }
  res.status(204).end();
});

app.post("/api/admin/providers/:id/fetch-models", async (req: Request, res: Response) => {
  try {
    res.json({ models: await fetchProviderModels(req.params.id as string) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(message === "provider not found" ? 404 : 502).json({ error: message });
  }
});

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

function toChatCompletionMessage(
  message: NonNullable<ChatRequestBody["messages"]>[number],
): ChatCompletionMessageParam | null {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content };
    case "user":
      return { role: "user", content: message.content };
    case "assistant":
      return { role: "assistant", content: message.content };
    case "tool":
      // Persisted tool rows lack the matching assistant tool_calls required by OpenAI.
      return null;
  }
}

app.post("/api/chat", async (req: Request, res: Response) => {
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

  let bindings: ReturnType<typeof normalizeResourceBindings>;
  let fullContent = "";
  const selectedProvider = getProvider(providerId || "default", { requireEnabled: true });
  if (!selectedProvider) {
    res
      .status(400)
      .json({ error: providerId ? "provider not found" : "default provider is unavailable" });
    return;
  }
  let openai: ReturnType<typeof createProviderClient>;
  try {
    openai = createProviderClient(selectedProvider);
  } catch (error) {
    const missingCredentials = error instanceof Error && /missing credentials/i.test(error.message);
    const message = missingCredentials
      ? `Provider「${selectedProvider.name}」未配置 API Key，请在「设置」中为该 Provider 填写 API Key`
      : error instanceof Error
        ? error.message
        : String(error);
    logTrace("chat.provider_unavailable", { providerId: selectedProvider.id, error: message }, "warn");
    res.status(400).json({ error: message });
    return;
  }
  const selectedModel = model || selectedProvider.models[0] || "gpt-4o-mini";
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

  try {
    const completionMessages: ChatCompletionMessageParam[] = messages
      .map(toChatCompletionMessage)
      .filter((message): message is ChatCompletionMessageParam => message !== null);
    const lastUserQuery = [...messages]
      .reverse()
      .find((message) => message.role === "user")?.content;
    if (bindings.rag.sources.length > 0 && lastUserQuery) {
      const ragStartedAt = Date.now();
      const rag = await retrieveRag({ query: lastUserQuery, ...bindings.rag });
      logDuration("chat.rag", ragStartedAt, {
        sources: bindings.rag.sources.length,
        topK: bindings.rag.topK,
        chunks: rag.chunks.length,
        query: truncate(lastUserQuery, 120),
      });
      send({ rag_citations: rag.chunks });
      if (rag.formatted) {
        completionMessages.unshift({
          role: "system",
          content:
            "优先基于以下挂载文档回答，并用【来源】标注引用；资料未覆盖时如实说明。\n\n" +
            rag.formatted,
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
    const completionTools = [...tools, ...mcpTools.map((tool) => tool.definition)];
    const maxToolRounds = 4;
    for (let round = 0; round <= maxToolRounds; round += 1) {
      const callsByIndex = new Map<number, { id?: string; name?: string; arguments: string }>();
      let roundContent = "";
      const allowTools = round < maxToolRounds;
      const roundStartedAt = Date.now();
      const stream = await openai.chat.completions.create({
        model: selectedModel,
        messages: completionMessages,
        stream: true,
        ...(allowTools ? { tools: completionTools } : {}),
      });

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;
        if (choice.delta?.content) {
          roundContent += choice.delta.content;
          fullContent += choice.delta.content;
          send({ delta: choice.delta.content });
        }
        for (const toolCall of choice.delta?.tool_calls ?? []) {
          const index = toolCall.index ?? 0;
          const current = callsByIndex.get(index) ?? { arguments: "" };
          if (toolCall.id) current.id = toolCall.id;
          if (toolCall.function?.name) current.name = (current.name ?? "") + toolCall.function.name;
          if (toolCall.function?.arguments) current.arguments += toolCall.function.arguments;
          callsByIndex.set(index, current);
        }
      }
      logDuration(`chat.llm.round${round}`, roundStartedAt, {
        allowTools,
        roundContentLength: roundContent.length,
      });
      if (!allowTools) break;

      const calls = [...callsByIndex.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, call], index) => ({ ...call, id: call.id ?? `call_${round}_${index}` }))
        .filter((call): call is { id: string; name: string; arguments: string } =>
          Boolean(call.name),
        );
      if (calls.length === 0) break;
      toolRounds += 1;

      completionMessages.push({
        role: "assistant",
        content: roundContent || null,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
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
        completionMessages.push({ role: "tool", tool_call_id: call.id, content: toolContent });
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
    const message = error instanceof Error ? error.message : "OpenAI request failed";
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

app.post("/api/workflow/run", async (req: Request, res: Response) => {
  const request = req.body as WorkflowRunRequest;
  try {
    validateWorkflow(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res
      .status(error instanceof WorkflowValidationError ? error.statusCode : 400)
      .json({ error: message });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (event: WorkflowEvent) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const controller = new AbortController();
  req.once("aborted", () => controller.abort());
  res.once("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  try {
    await executeWorkflow(request, (event) => send(event), { signal: controller.signal });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send({
      type: "run_error",
      ...(error instanceof WorkflowNodeError ? { nodeId: error.nodeId } : {}),
      error: message,
    });
  } finally {
    res.end();
  }
});

app.post("/api/workflow/node/test", async (req: Request, res: Response) => {
  const controller = new AbortController();
  req.once("aborted", () => controller.abort());
  try {
    const result = await executeWorkflowNodeTest(req.body as WorkflowNodeTestRequest, {
      signal: controller.signal,
    });
    res.json({ result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res
      .status(error instanceof WorkflowValidationError ? error.statusCode : 400)
      .json({ error: message });
  }
});

export { app };

if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => {
    console.log(`server listening on http://localhost:${port}`);
    console.log(`sqlite: ${getDbPath()}`);
    logTrace("server.started", {
      port,
      db: getDbPath(),
      env: process.env.NODE_ENV ?? "development",
    });
  });
}
