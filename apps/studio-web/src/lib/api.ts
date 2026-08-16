import type {
  ChatRequestMessage,
  ChatResourceBinding,
  RagCitation,
  Session,
  ToolCall,
  UiBlock,
} from "../types.js";

interface StreamCallbacks {
  onDelta: (delta: string) => void;
  onDone: (meta?: { assistantMessageId?: string }) => void;
  onError: (error: string) => void;
  onAssistantMessageId?: (id: string) => void;
  onRagCitations?: (citations: RagCitation[]) => void;
  /** 收到一次“函数调用请求”（name + arguments）。 */
  onToolCall?: (call: ToolCall) => void;
  /** 收到“函数调用结果”（result / ui / error）。 */
  onToolResult?: (result: {
    id?: string;
    name: string;
    result?: unknown;
    ui?: UiBlock;
    error?: string;
  }) => void;
}

async function parseError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `HTTP ${res.status}`;
}

export async function fetchSessions(): Promise<Session[]> {
  const res = await fetch("/api/sessions");
  if (!res.ok) throw new Error(await parseError(res));
  const body = (await res.json()) as { sessions: Session[] };
  return body.sessions;
}

export async function createSessionApi(input?: { id?: string; title?: string }): Promise<Session> {
  const res = await fetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input ?? {}),
  });
  if (!res.ok) throw new Error(await parseError(res));
  const body = (await res.json()) as { session: Session };
  return body.session;
}

export async function renameSessionApi(id: string, title: string): Promise<Session> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  const body = (await res.json()) as { session: Session };
  return body.session;
}

export async function deleteSessionApi(id: string): Promise<void> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) throw new Error(await parseError(res));
}

export async function deleteMessageApi(id: string): Promise<void> {
  const res = await fetch(`/api/messages/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) throw new Error(await parseError(res));
}

/**
 * 把 SSE 缓冲按事件边界（`\n\n`）切分，返回解析出的事件对象与剩余的（不完整的）缓冲。
 * 每个事件可能包含多行字段（如 `event:` + `data:`），这里只提取 `data:` 字段并解析 JSON。
 * 提取为纯函数以便单元测试。
 */
export function parseSseBuffer(buffer: string): {
  events: Array<Record<string, unknown>>;
  rest: string;
} {
  const rawEvents = buffer.split("\n\n");
  const rest = rawEvents.pop() ?? "";
  const events: Array<Record<string, unknown>> = [];

  for (const event of rawEvents) {
    let dataValue = "";
    let hasData = false;
    for (const line of event.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const value = trimmed.slice("data:".length).replace(/^ /, "");
      dataValue += (hasData ? "\n" : "") + value;
      hasData = true;
    }
    if (!hasData) continue;
    try {
      events.push(JSON.parse(dataValue) as Record<string, unknown>);
    } catch {
      // 跨 chunk 的半包 JSON —— 忽略，等待后续拼齐。
    }
  }

  return { events, rest };
}

/**
 * POST 到 /api/chat 并解析 SSE 流。
 * 返回 AbortController 以便调用方取消。
 */
export function streamChat(
  messages: ChatRequestMessage[],
  model: string | undefined,
  callbacks: StreamCallbacks,
  opts?: {
    sessionId?: string;
    userMessage?: { id?: string; content: string };
    resources?: ChatResourceBinding;
    /** 指定走哪个已配置的 Provider（缺省由服务端路由到 default）。 */
    providerId?: string;
  },
): AbortController {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages,
          model,
          sessionId: opts?.sessionId,
          userMessage: opts?.userMessage,
          resources: opts?.resources,
          ...(opts?.providerId ? { providerId: opts.providerId } : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        callbacks.onError(await parseError(res));
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        callbacks.onError("No response body");
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let assistantMessageId: string | undefined;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = parseSseBuffer(buffer);
        buffer = rest;

        for (const data of events) {
          if (typeof data.assistantMessageId === "string") {
            assistantMessageId = data.assistantMessageId;
            callbacks.onAssistantMessageId?.(assistantMessageId);
          }
          if (data.tool_call) {
            callbacks.onToolCall?.(data.tool_call as ToolCall);
          }
          if (Array.isArray(data.rag_citations)) {
            callbacks.onRagCitations?.(data.rag_citations as RagCitation[]);
          }
          if (data.tool_result) {
            callbacks.onToolResult?.(
              data.tool_result as Parameters<NonNullable<StreamCallbacks["onToolResult"]>>[0],
            );
          }
          if (data.error) {
            callbacks.onError(data.error as string);
            return;
          }
          if (data.done) {
            callbacks.onDone({ assistantMessageId });
            return;
          }
          if (data.delta) {
            callbacks.onDelta(data.delta as string);
          }
        }
      }

      // 流式连接正常关闭但未收到 done 事件时，兜底结束本次对话，
      // 避免前端一直停留在 loading 状态。
      callbacks.onDone({ assistantMessageId });
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      callbacks.onError(err instanceof Error ? err.message : "Request failed");
    }
  })();

  return controller;
}

export interface WorkflowRunNode {
  id: string;
  kind: string;
  label: string;
  config: Record<string, unknown>;
}

export interface WorkflowRunEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface WorkflowRunRequest {
  nodes: WorkflowRunNode[];
  edges: WorkflowRunEdge[];
  input: Record<string, unknown>;
}

export interface WorkflowTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** 单个节点本次运行的完整信息，供运行轨迹日志展示与调试。 */
export interface WorkflowNodeRunMeta {
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  result?: unknown;
  /** LLM 节点插值后的最终请求内容（user 消息）。 */
  prompt?: string;
  /** LLM 节点插值后的系统提示词（system 消息）。 */
  systemPrompt?: string;
  error?: string;
  metadata?: {
    durationMs: number;
    tokenUsage: WorkflowTokenUsage;
  };
}

export interface WorkflowNodeTestResult {
  nodeId: string;
  status: "success" | "error";
  inputs: Record<string, unknown>;
  result: unknown;
  outputs: Record<string, unknown>;
  error?: string;
  metadata: {
    nodeKind: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    tokenUsage: WorkflowTokenUsage;
  };
}

export async function testWorkflowNode(
  node: WorkflowRunNode,
  inputs: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<WorkflowNodeTestResult> {
  const response = await fetch("/api/workflow/node/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ node, inputs }),
    signal,
  });
  if (!response.ok) throw new Error(await parseError(response));
  return ((await response.json()) as { result: WorkflowNodeTestResult }).result;
}

export interface WorkflowStreamCallbacks {
  onNodeStart: (nodeId: string, label?: string, kind?: string) => void;
  onNodeResult: (nodeId: string, status: "success" | "error", meta: WorkflowNodeRunMeta) => void;
  onDone: (outputs: Record<string, Record<string, unknown>>) => void;
  onError: (error: string, nodeId?: string) => void;
}

export function streamWorkflow(
  request: WorkflowRunRequest,
  callbacks: WorkflowStreamCallbacks,
): AbortController {
  const controller = new AbortController();
  (async () => {
    try {
      const response = await fetch("/api/workflow/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!response.ok) {
        callbacks.onError(await parseError(response));
        return;
      }
      const reader = response.body?.getReader();
      if (!reader) {
        callbacks.onError("No response body");
        return;
      }
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseBuffer(buffer);
        buffer = parsed.rest;
        for (const event of parsed.events) {
          if (event.type === "node_start" && typeof event.nodeId === "string")
            callbacks.onNodeStart(
              event.nodeId,
              typeof event.label === "string" ? event.label : undefined,
              typeof event.kind === "string" ? event.kind : undefined,
            );
          if (
            event.type === "node_result" &&
            typeof event.nodeId === "string" &&
            (event.status === "success" || event.status === "error")
          )
            callbacks.onNodeResult(event.nodeId, event.status, {
              inputs: event.inputs as Record<string, unknown> | undefined,
              outputs: event.outputs as Record<string, unknown> | undefined,
              result: event.result,
              prompt: typeof event.prompt === "string" ? event.prompt : undefined,
              systemPrompt:
                typeof event.systemPrompt === "string" ? event.systemPrompt : undefined,
              error: typeof event.error === "string" ? event.error : undefined,
              metadata: event.metadata as WorkflowNodeRunMeta["metadata"],
            });
          if (event.type === "run_done")
            callbacks.onDone((event.outputs ?? {}) as Record<string, Record<string, unknown>>);
          if (event.type === "run_error")
            callbacks.onError(
              typeof event.error === "string" ? event.error : "Workflow execution failed",
              typeof event.nodeId === "string" ? event.nodeId : undefined,
            );
        }
      }
    } catch (reason) {
      if ((reason as Error).name !== "AbortError")
        callbacks.onError(reason instanceof Error ? reason.message : "Workflow request failed");
    }
  })();
  return controller;
}
