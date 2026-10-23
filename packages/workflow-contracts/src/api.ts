/** Serializable workflow management DTOs. Editor-specific graph types remain generic. */
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
export interface WorkflowVersionRecord<Snapshot = WorkflowSnapshot> {
  id: string;
  workflowId: string;
  versionNumber: number;
  name: string;
  releaseNotes: string;
  graph: Snapshot;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  createdAt: string;
}
export interface WorkflowDetailRecord<Snapshot = WorkflowSnapshot> {
  app: WorkflowAppRecord;
  draft: Snapshot;
  versions: WorkflowVersionRecord<Snapshot>[];
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
export interface WorkflowRunHistory<Snapshot = WorkflowSnapshot> {
  run: WorkflowRunRecord;
  events: WorkflowRunEventRecord[];
  graph: Snapshot;
}
