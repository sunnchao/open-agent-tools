import type { WorkflowSnapshot } from "./types.js";

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

async function parseResponse<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

export async function fetchWorkflows(): Promise<WorkflowAppRecord[]> {
  const response = await fetch("/api/workflows");
  return (await parseResponse<{ workflows: WorkflowAppRecord[] }>(response)).workflows;
}

export async function fetchWorkflow(workflowId: string): Promise<{
  workflow: WorkflowDetailRecord;
  apiKeys: WorkflowApiKeyRecord[];
}> {
  const response = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}`);
  return parseResponse(response);
}

export async function createWorkflow(input: {
  name: string;
  description?: string;
  graph?: WorkflowSnapshot;
}): Promise<WorkflowDetailRecord> {
  const response = await fetch("/api/workflows", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return (await parseResponse<{ workflow: WorkflowDetailRecord }>(response)).workflow;
}

export async function duplicateWorkflow(workflowId: string): Promise<WorkflowDetailRecord> {
  const response = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}/duplicate`, {
    method: "POST",
  });
  return (await parseResponse<{ workflow: WorkflowDetailRecord }>(response)).workflow;
}

export async function deleteWorkflow(workflowId: string): Promise<void> {
  const response = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}`, {
    method: "DELETE",
  });
  if (!response.ok && response.status !== 404) await parseResponse(response);
}

export async function saveWorkflowDraft(
  workflowId: string,
  expectedRevision: number,
  graph: WorkflowSnapshot,
): Promise<WorkflowDetailRecord> {
  const response = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}/draft`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision, graph }),
  });
  return (await parseResponse<{ workflow: WorkflowDetailRecord }>(response)).workflow;
}

export async function publishWorkflow(
  workflowId: string,
  expectedRevision: number,
  releaseNotes = "",
): Promise<WorkflowDetailRecord> {
  const response = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}/publish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision, releaseNotes }),
  });
  return (await parseResponse<{ workflow: WorkflowDetailRecord }>(response)).workflow;
}

export async function rollbackWorkflow(
  workflowId: string,
  versionId: string,
): Promise<WorkflowDetailRecord> {
  const response = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}/rollback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ versionId }),
  });
  return (await parseResponse<{ workflow: WorkflowDetailRecord }>(response)).workflow;
}

export async function createWorkflowKey(
  workflowId: string,
  input: { name: string; rateLimitPerMinute: number },
): Promise<{ key: WorkflowApiKeyRecord; rawKey: string }> {
  const response = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}/api-keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return parseResponse(response);
}

export async function revokeWorkflowKey(workflowId: string, keyId: string): Promise<void> {
  const response = await fetch(
    `/api/workflows/${encodeURIComponent(workflowId)}/api-keys/${encodeURIComponent(keyId)}`,
    { method: "DELETE" },
  );
  if (!response.ok && response.status !== 404) await parseResponse(response);
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

export async function fetchWorkflowRuns(
  workflowId: string,
  signal?: AbortSignal,
): Promise<WorkflowRunRecord[]> {
  const response = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}/runs`, { signal });
  return (await parseResponse<{ runs: WorkflowRunRecord[] }>(response)).runs;
}

export async function fetchWorkflowRunEvents(
  workflowId: string,
  runId: string,
  signal?: AbortSignal,
): Promise<WorkflowRunHistory> {
  const response = await fetch(
    `/api/workflows/${encodeURIComponent(workflowId)}/runs/${encodeURIComponent(runId)}/events`,
    { signal },
  );
  return parseResponse(response);
}
