import { config as loadEnv } from "dotenv";
import cors from "cors";
import express, { type Request, type Response } from "express";
import { OpenAI } from "openai";
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

loadEnv({ path: resolve(import.meta.dirname, "../.env") });
loadEnv({ path: resolve(import.meta.dirname, "../.env.local"), override: true });

const app = express();
const port = Number(process.env.PORT) || 3000;
const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  throw new Error("Missing OPENAI_API_KEY. Set it in apps/server/.env.local or the environment.");
}

const webOrigin = process.env.WEB_ORIGIN || "http://localhost:5173";

openDb();

app.use(cors({ origin: webOrigin }));
app.use(express.json({ limit: "2mb" }));

const openai = new OpenAI({
  apiKey,
  baseURL: process.env.OPENAI_API_BASE_URL,
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

app.get("/api/sessions", (_req: Request, res: Response) => {
  res.json({ sessions: listSessionsWithMessages() });
});

app.post("/api/sessions", (req: Request, res: Response) => {
  const body = req.body as { id?: string; title?: string } | undefined;
  const session = createSession({
    id: typeof body?.id === "string" ? body.id : undefined,
    title: typeof body?.title === "string" ? body.title : undefined,
  });
  res.status(201).json({ session });
});

app.get("/api/sessions/:id", (req: Request, res: Response) => {
  const session = getSession(req.params.id as string);
  if (!session) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  res.json({ session });
});

app.patch("/api/sessions/:id", (req: Request, res: Response) => {
  const { title } = req.body as { title?: string };
  if (typeof title !== "string" || !title.trim()) {
    res.status(400).json({ error: "title is required" });
    return;
  }
  const session = renameSession(req.params.id as string, title.trim());
  if (!session) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  res.json({ session });
});

app.delete("/api/sessions/:id", (req: Request, res: Response) => {
  const ok = deleteSession(req.params.id as string);
  if (!ok) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  res.status(204).end();
});

app.delete("/api/messages/:id", (req: Request, res: Response) => {
  const ok = deleteMessage(req.params.id as string);
  if (!ok) {
    res.status(404).json({ error: "message not found" });
    return;
  }
  res.status(204).end();
});

interface ChatRequestBody {
  messages?: Array<{ role: Role; content: string }>;
  model?: string;
  sessionId?: string;
  userMessage?: { id?: string; content: string };
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
  const { messages, model, sessionId, userMessage } = req.body as ChatRequestBody;

  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "messages must be a non-empty array" });
    return;
  }

  for (const m of messages) {
    if (!["user", "assistant", "system", "tool"].includes(m.role)) {
      res.status(400).json({ error: `invalid role: ${m.role}` });
      return;
    }
  }

  const resolvedSessionId = sessionId;
  let assistantMessageId: string | null = null;

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
  const toolCallsByIndex = new Map<
    number,
    {
      id?: string;
      name?: string;
      arguments: string;
    }
  >();
  let finishReason: string | null = null;

  try {
    const completionMessages = messages
      .map(toChatCompletionMessage)
      .filter((message): message is ChatCompletionMessageParam => message !== null);
    const stream = await openai.chat.completions.create({
      model: model || process.env.OPENAI_API_MODEL || "step-3.7-flash",
      messages: completionMessages,
      stream: true,
      tools: tools,
    });

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;
      console.log("choice.delta", JSON.stringify(choice.delta));

      if (choice.delta?.content) {
        fullContent += choice.delta.content;
        send({ delta: choice.delta.content });
      }

      for (const tc of choice.delta?.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const prev = toolCallsByIndex.get(idx) ?? { arguments: "" };
        if (tc.id) prev.id = tc.id;
        if (tc.function?.name) prev.name = (prev.name ?? "") + tc.function.name;
        if (tc.function?.arguments) prev.arguments += tc.function.arguments;
        toolCallsByIndex.set(idx, prev);
      }

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
    }

    const hasToolCall = toolCallsByIndex.size > 0 || finishReason === "tool_calls";
    if (hasToolCall && resolvedSessionId) {
      const calls = [...toolCallsByIndex.entries()].sort(([a], [b]) => a - b).map(([, v]) => v);

      for await (const call of calls) {
        if (!call.name) continue;

        // 1) 把“函数调用请求”作为结构化事件推给前端，便于前端作为对话记录缓存。
        send({
          tool_call: {
            id: call.id,
            name: call.name,
            arguments: call.arguments,
          },
        });

        // 2) 执行工具，并把“调用结果”作为结构化事件推给前端。
        let result: unknown;
        try {
          result = await executeTool(call.name, call.arguments);
          if (
            result &&
            typeof result === "object" &&
            "ui" in result &&
            (result as { ui?: unknown }).ui
          ) {
            const ui = (result as { ui: unknown }).ui;
            send({ tool_result: { id: call.id, name: call.name, ui } });
            addMessage(resolvedSessionId, {
              role: "tool",
              content: JSON.stringify({ ui }),
              tool_call_id: call.id,
              tool_name: call.name,
              status: "complete",
            });
          } else {
            send({ tool_result: { id: call.id, name: call.name, result } });
            addMessage(resolvedSessionId, {
              role: "tool",
              content: JSON.stringify(result),
              tool_call_id: call.id,
              tool_name: call.name,
              status: "complete",
            });
          }
        } catch (e) {
          const message = String(e);
          send({ tool_result: { id: call.id, name: call.name, error: message } });
          addMessage(resolvedSessionId, {
            role: "tool",
            content: JSON.stringify({ error: message }),
            tool_call_id: call.id,
            tool_name: call.name,
            status: "error",
          });
        }
      }
    }

    if (assistantMessageId) {
      updateMessage(assistantMessageId, { content: fullContent, status: "complete" });
    }

    send({ done: true, assistantMessageId: assistantMessageId ?? undefined });
  } catch (error) {
    const message = error instanceof Error ? error.message : "OpenAI request failed";
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

app.listen(port, () => {
  console.log(`server listening on http://localhost:${port}`);
  console.log(`sqlite: ${getDbPath()}`);
});
