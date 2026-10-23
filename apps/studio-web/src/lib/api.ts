import type {
  ChatRequestMessage,
  ChatResourceBinding,
  MessageUsage,
  RagCitation,
  Session,
  ToolCall,
  UiBlock,
} from "../types.js";
import type { ConditionWarning } from "@open-agent-tools/workflow-contracts";
import { studioFetch } from "./client.js";
import { consumeSse, parseHttpError as parseError } from "@open-agent-tools/studio-client";
export { parseSseBuffer } from "@open-agent-tools/studio-client";

interface StreamCallbacks {
  onDelta: (delta: string) => void;
  onDone: (meta?: { assistantMessageId?: string; usage?: MessageUsage }) => void;
  onError: (error: string) => void;
  /** 用户主动停止。与 onError / onDone 互斥，避免停止后被标成 complete。 */
  onStopped?: () => void;
  onAssistantMessageId?: (id: string) => void;
  onRagCitations?: (citations: RagCitation[]) => void;
  /** token / 工具用量（每轮结束与 done 各下发一次，后者为整轮累计）。 */
  onUsage?: (usage: MessageUsage) => void;
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

export async function fetchSessions(): Promise<Session[]> {
  const res = await studioFetch("/api/sessions");
  if (!res.ok) throw new Error(await parseError(res));
  const body = (await res.json()) as { sessions: Session[] };
  return body.sessions;
}

export async function createSessionApi(input?: { id?: string; title?: string }): Promise<Session> {
  const res = await studioFetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input ?? {}),
  });
  if (!res.ok) throw new Error(await parseError(res));
  const body = (await res.json()) as { session: Session };
  return body.session;
}

export async function renameSessionApi(id: string, title: string): Promise<Session> {
  const res = await studioFetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  const body = (await res.json()) as { session: Session };
  return body.session;
}

export async function deleteSessionApi(id: string): Promise<void> {
  const res = await studioFetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) throw new Error(await parseError(res));
}

export async function deleteMessageApi(id: string): Promise<void> {
  const res = await studioFetch(`/api/messages/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) throw new Error(await parseError(res));
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
      const res = await studioFetch("/api/chat", {
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

      if (!res.body?.getReader) {
        callbacks.onError("No response body");
        return;
      }
      let assistantMessageId: string | undefined;
      let usage: MessageUsage | undefined;
      let completed = false;
      await consumeSse(res, (data) => {
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
        // 中途的 usage 事件即时回调；done 携带的终局用量只通过 onDone 给出，避免重复。
        if (data.usage && typeof data.usage === "object" && !data.done) {
          usage = data.usage as MessageUsage;
          callbacks.onUsage?.(usage);
        }
        if (data.tool_result) {
          callbacks.onToolResult?.(
            data.tool_result as Parameters<NonNullable<StreamCallbacks["onToolResult"]>>[0],
          );
        }
        if (data.error) {
          completed = true;
          callbacks.onError(data.error as string);
          return true;
        }
        if (data.done) {
          const finalUsage =
            data.usage && typeof data.usage === "object" ? (data.usage as MessageUsage) : usage;
          completed = true;
          callbacks.onDone({ assistantMessageId, ...(finalUsage ? { usage: finalUsage } : {}) });
          return true;
        }
        if (data.delta) {
          callbacks.onDelta(data.delta as string);
        }
      });
      if (completed) return;

      // 流式连接正常关闭但未收到 done 事件时，兜底结束本次对话，
      // 避免前端一直停留在 loading 状态。
      callbacks.onDone({ assistantMessageId, ...(usage ? { usage } : {}) });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        callbacks.onStopped?.();
        return;
      }
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
  branchId?: string;
}

export interface WorkflowRunRequest {
  workflowId?: string;
  resume?: { runId: string; fromNodeId: string };
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
    attempts?: number;
    cached?: boolean;
    incomingEdgeIds?: string[];
    selectedBranchId?: string;
    selectedBranchLabel?: string;
    warnings?: ConditionWarning[];
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
    attempts?: number;
    selectedBranchId?: string;
    selectedBranchLabel?: string;
    warnings?: ConditionWarning[];
  };
}

export async function testWorkflowNode(
  node: WorkflowRunNode,
  inputs: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<WorkflowNodeTestResult> {
  const response = await studioFetch("/api/workflow/node/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ node, inputs }),
    signal,
  });
  if (!response.ok) throw new Error(await parseError(response));
  return ((await response.json()) as { result: WorkflowNodeTestResult }).result;
}

export interface WorkflowStreamCallbacks {
  onNodeStart: (nodeId: string, label?: string, kind?: string, incomingEdgeIds?: string[]) => void;
  onNodeResult: (nodeId: string, status: "success" | "error", meta: WorkflowNodeRunMeta) => void;
  onDone: (
    outputs: Record<string, unknown>,
    nodeOutputs: Record<string, Record<string, unknown>>,
  ) => void;
  onError: (error: string, nodeId?: string) => void;
}

export function streamWorkflow(
  request: WorkflowRunRequest,
  callbacks: WorkflowStreamCallbacks,
): AbortController {
  const controller = new AbortController();
  (async () => {
    try {
      const response = await studioFetch("/api/workflow/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!response.ok) {
        callbacks.onError(await parseError(response));
        return;
      }
      if (!response.body?.getReader) {
        callbacks.onError("No response body");
        return;
      }
      await consumeSse(response, (event) => {
        if (event.type === "node_start" && typeof event.nodeId === "string")
          callbacks.onNodeStart(
            event.nodeId,
            typeof event.label === "string" ? event.label : undefined,
            typeof event.kind === "string" ? event.kind : undefined,
            Array.isArray(event.incomingEdgeIds)
              ? event.incomingEdgeIds.filter((id): id is string => typeof id === "string")
              : undefined,
          );
        if (
          (event.type === "node_result" || event.type === "node_cached") &&
          typeof event.nodeId === "string" &&
          (event.status === "success" || event.status === "error")
        )
          callbacks.onNodeResult(event.nodeId, event.status, {
            inputs: event.inputs as Record<string, unknown> | undefined,
            outputs: event.outputs as Record<string, unknown> | undefined,
            result: event.result,
            prompt: typeof event.prompt === "string" ? event.prompt : undefined,
            systemPrompt: typeof event.systemPrompt === "string" ? event.systemPrompt : undefined,
            error: typeof event.error === "string" ? event.error : undefined,
            metadata: (() => {
              const metadata =
                event.metadata && typeof event.metadata === "object"
                  ? (event.metadata as NonNullable<WorkflowNodeRunMeta["metadata"]>)
                  : ({
                      durationMs: 0,
                      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                    } satisfies NonNullable<WorkflowNodeRunMeta["metadata"]>);
              return {
                durationMs: metadata.durationMs ?? 0,
                tokenUsage: metadata.tokenUsage,
                ...(metadata.attempts === undefined ? {} : { attempts: metadata.attempts }),
                ...(metadata.cached === undefined ? {} : { cached: metadata.cached }),
                ...(metadata.selectedBranchId
                  ? { selectedBranchId: metadata.selectedBranchId }
                  : {}),
                ...(metadata.selectedBranchLabel
                  ? { selectedBranchLabel: metadata.selectedBranchLabel }
                  : {}),
                ...(metadata.warnings?.length ? { warnings: metadata.warnings } : {}),
                ...(Array.isArray(event.incomingEdgeIds)
                  ? {
                      incomingEdgeIds: event.incomingEdgeIds.filter(
                        (id): id is string => typeof id === "string",
                      ),
                    }
                  : {}),
              };
            })(),
          });
        if (event.type === "run_done") {
          callbacks.onDone(
            (event.outputs ?? {}) as Record<string, unknown>,
            (event.nodeOutputs ?? {}) as Record<string, Record<string, unknown>>,
          );
          return true;
        }
        if (event.type === "run_error") {
          callbacks.onError(
            typeof event.error === "string" ? event.error : "Workflow execution failed",
            typeof event.nodeId === "string" ? event.nodeId : undefined,
          );
          return true;
        }
      });
    } catch (reason) {
      if ((reason as Error).name !== "AbortError")
        callbacks.onError(reason instanceof Error ? reason.message : "Workflow request failed");
    }
  })();
  return controller;
}
