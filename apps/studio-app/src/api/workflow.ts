import { createWorkflowClient } from "@open-agent-tools/studio-client";
import { agentFetch, parseError } from "../lib/http";
import { consumeSse } from "../lib/sse";

export type {
  WorkflowAppRecord,
  WorkflowNode,
  WorkflowEdge,
  WorkflowSnapshot,
  WorkflowVersionRecord,
  WorkflowDetailRecord,
  WorkflowApiKeyRecord,
  WorkflowRunRecord,
  WorkflowRunEventRecord,
  WorkflowRunHistory,
} from "@open-agent-tools/workflow-contracts";

export const {
  fetchWorkflows,
  fetchWorkflow,
  createWorkflow,
  duplicateWorkflow,
  deleteWorkflow,
  saveWorkflowDraft,
  publishWorkflow,
  rollbackWorkflow,
  createWorkflowKey,
  revokeWorkflowKey,
  fetchWorkflowRuns,
  fetchWorkflowRunEvents,
} = createWorkflowClient(agentFetch);

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
export interface WorkflowNodeRunMeta {
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  result?: unknown;
  prompt?: string;
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
    warnings?: Array<{ message: string }>;
  };
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

export async function testWorkflowNode(
  node: WorkflowRunNode,
  inputs: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{
  nodeId: string;
  status: "success" | "error";
  inputs: Record<string, unknown>;
  result: unknown;
  outputs: Record<string, unknown>;
  error?: string;
}> {
  const r = await agentFetch("/api/workflow/node/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ node, inputs }),
    signal,
  });
  if (!r.ok) throw new Error(await parseError(r));
  return (
    (await r.json()) as {
      result: {
        nodeId: string;
        status: "success" | "error";
        inputs: Record<string, unknown>;
        result: unknown;
        outputs: Record<string, unknown>;
        error?: string;
      };
    }
  ).result;
}

export function streamWorkflow(
  request: WorkflowRunRequest,
  callbacks: WorkflowStreamCallbacks,
): { abort: () => void } {
  const controller = new AbortController();
  void (async () => {
    try {
      const response = await agentFetch("/api/workflow/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!response.ok) {
        callbacks.onError(await parseError(response));
        return;
      }
      let done = false;
      await consumeSse(response, (event) => {
        if (event.type === "node_start" && typeof event.nodeId === "string") {
          callbacks.onNodeStart(
            event.nodeId,
            typeof event.label === "string" ? event.label : undefined,
            typeof event.kind === "string" ? event.kind : undefined,
            Array.isArray(event.incomingEdgeIds)
              ? event.incomingEdgeIds.filter((id): id is string => typeof id === "string")
              : undefined,
          );
        }
        if (
          (event.type === "node_result" || event.type === "node_cached") &&
          typeof event.nodeId === "string" &&
          (event.status === "success" || event.status === "error")
        ) {
          const metadata =
            event.metadata && typeof event.metadata === "object"
              ? (event.metadata as NonNullable<WorkflowNodeRunMeta["metadata"]>)
              : { durationMs: 0, tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
          callbacks.onNodeResult(event.nodeId, event.status, {
            inputs: event.inputs as Record<string, unknown> | undefined,
            outputs: event.outputs as Record<string, unknown> | undefined,
            result: event.result,
            prompt: typeof event.prompt === "string" ? event.prompt : undefined,
            systemPrompt: typeof event.systemPrompt === "string" ? event.systemPrompt : undefined,
            error: typeof event.error === "string" ? event.error : undefined,
            metadata: {
              durationMs: metadata.durationMs ?? 0,
              tokenUsage: metadata.tokenUsage,
              ...(metadata.attempts === undefined ? {} : { attempts: metadata.attempts }),
            },
          });
        }
        if (event.type === "run_done") {
          done = true;
          callbacks.onDone(
            (event.outputs ?? {}) as Record<string, unknown>,
            (event.nodeOutputs ?? {}) as Record<string, Record<string, unknown>>,
          );
          return true;
        }
        if (event.type === "run_error") {
          done = true;
          callbacks.onError(
            typeof event.error === "string" ? event.error : "Workflow execution failed",
            typeof event.nodeId === "string" ? event.nodeId : undefined,
          );
          return true;
        }
        return false;
      });
      if (!done) callbacks.onError("工作流连接中断");
    } catch (reason) {
      if ((reason as Error).name !== "AbortError")
        callbacks.onError(reason instanceof Error ? reason.message : "Workflow request failed");
    }
  })();
  return { abort: () => controller.abort() };
}
