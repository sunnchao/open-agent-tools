import { agentFetch, parseError } from "../lib/http";
import { consumeSse } from "../lib/sse";

export interface WorkflowAppRecord {
  id: string;
  name: string;
  slug: string;
  description: string;
  status: "ACTIVE" | "DELETED";
  draftRevision: number;
  currentVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface WorkflowSnapshot {
  name: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}
export interface WorkflowNode {
  id: string;
  type?: string;
  position?: { x: number; y: number };
  data: {
    id?: string;
    kind: string;
    label?: string;
    description?: string;
    status?: string;
    config?: Record<string, unknown>;
  };
}
export interface WorkflowEdge {
  id?: string;
  source: string;
  target: string;
  label?: unknown;
  branchId?: string;
  sourceHandle?: string;
  type?: string;
}
export interface WorkflowVersionRecord {
  id: string;
  workflowId: string;
  versionNumber: number;
  name: string;
  releaseNotes: string;
  graph: WorkflowSnapshot;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  createdAt: string;
}
export interface WorkflowDetailRecord {
  app: WorkflowAppRecord;
  draft: WorkflowSnapshot;
  versions: WorkflowVersionRecord[];
}
export interface WorkflowApiKeyRecord {
  id: string;
  workflowId: string;
  name: string;
  prefix: string;
  status: "ACTIVE" | "REVOKED";
  rateLimitPerMinute: number;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}
export interface WorkflowRunRecord {
  id: string;
  taskId: string;
  workflowId: string;
  versionId: string | null;
  user: string;
  source: "service-api" | "studio";
  status: "running" | "succeeded" | "failed" | "stopped";
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown> | null;
  error: string | null;
  totalSteps: number;
  totalTokens: number;
  createdAt: string;
  finishedAt: string | null;
  elapsedTime: number | null;
}
export interface WorkflowRunEventRecord {
  runId: string;
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}
export interface WorkflowRunHistory {
  run: WorkflowRunRecord;
  events: WorkflowRunEventRecord[];
  graph: WorkflowSnapshot;
}

async function parse<T>(r: Response): Promise<T> {
  let body: T & { error?: string };
  try {
    body = (await r.json()) as T & { error?: string };
  } catch {
    body = {} as T & { error?: string };
  }
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body;
}

export async function fetchWorkflows(): Promise<WorkflowAppRecord[]> {
  return (await parse<{ workflows: WorkflowAppRecord[] }>(await agentFetch("/api/workflows")))
    .workflows;
}
export async function fetchWorkflow(
  workflowId: string,
): Promise<{ workflow: WorkflowDetailRecord; apiKeys: WorkflowApiKeyRecord[] }> {
  return parse(await agentFetch(`/api/workflows/${encodeURIComponent(workflowId)}`));
}
export async function createWorkflow(input: {
  name: string;
  description?: string;
  graph?: WorkflowSnapshot;
}): Promise<WorkflowDetailRecord> {
  return (
    await parse<{ workflow: WorkflowDetailRecord }>(
      await agentFetch("/api/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    )
  ).workflow;
}
export async function duplicateWorkflow(workflowId: string): Promise<WorkflowDetailRecord> {
  return (
    await parse<{ workflow: WorkflowDetailRecord }>(
      await agentFetch(`/api/workflows/${encodeURIComponent(workflowId)}/duplicate`, {
        method: "POST",
      }),
    )
  ).workflow;
}
export async function deleteWorkflow(workflowId: string): Promise<void> {
  const r = await agentFetch(`/api/workflows/${encodeURIComponent(workflowId)}`, {
    method: "DELETE",
  });
  if (!r.ok && r.status !== 404) await parse(r);
}
export async function saveWorkflowDraft(
  workflowId: string,
  expectedRevision: number,
  graph: WorkflowSnapshot,
): Promise<WorkflowDetailRecord> {
  return (
    await parse<{ workflow: WorkflowDetailRecord }>(
      await agentFetch(`/api/workflows/${encodeURIComponent(workflowId)}/draft`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision, graph }),
      }),
    )
  ).workflow;
}
export async function publishWorkflow(
  workflowId: string,
  expectedRevision: number,
  releaseNotes = "",
): Promise<WorkflowDetailRecord> {
  return (
    await parse<{ workflow: WorkflowDetailRecord }>(
      await agentFetch(`/api/workflows/${encodeURIComponent(workflowId)}/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision, releaseNotes }),
      }),
    )
  ).workflow;
}
export async function rollbackWorkflow(
  workflowId: string,
  versionId: string,
): Promise<WorkflowDetailRecord> {
  return (
    await parse<{ workflow: WorkflowDetailRecord }>(
      await agentFetch(`/api/workflows/${encodeURIComponent(workflowId)}/rollback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ versionId }),
      }),
    )
  ).workflow;
}
export async function createWorkflowKey(
  workflowId: string,
  input: { name: string; rateLimitPerMinute: number },
): Promise<{ key: WorkflowApiKeyRecord; rawKey: string }> {
  return parse(
    await agentFetch(`/api/workflows/${encodeURIComponent(workflowId)}/api-keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}
export async function revokeWorkflowKey(workflowId: string, keyId: string): Promise<void> {
  const r = await agentFetch(
    `/api/workflows/${encodeURIComponent(workflowId)}/api-keys/${encodeURIComponent(keyId)}`,
    { method: "DELETE" },
  );
  if (!r.ok && r.status !== 404) await parse(r);
}
export async function fetchWorkflowRuns(
  workflowId: string,
  signal?: AbortSignal,
): Promise<WorkflowRunRecord[]> {
  return (
    await parse<{ runs: WorkflowRunRecord[] }>(
      await agentFetch(`/api/workflows/${encodeURIComponent(workflowId)}/runs`, { signal }),
    )
  ).runs;
}
export async function fetchWorkflowRunEvents(
  workflowId: string,
  runId: string,
  signal?: AbortSignal,
): Promise<WorkflowRunHistory> {
  return parse(
    await agentFetch(
      `/api/workflows/${encodeURIComponent(workflowId)}/runs/${encodeURIComponent(runId)}/events`,
      { signal },
    ),
  );
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
