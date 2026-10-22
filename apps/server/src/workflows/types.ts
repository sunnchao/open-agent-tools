import { migrateLegacyGraphNodes } from "@open-agent-tools/workflow-contracts";
import type { WorkflowEdgeInput, WorkflowNodeInput } from "../workflow/executor.js";

export interface WorkflowCanvasNode {
  id: string;
  type?: string;
  position?: { x: number; y: number };
  data: {
    id?: string;
    kind: WorkflowNodeInput["kind"];
    label?: string;
    description?: string;
    status?: string;
    config?: Record<string, unknown>;
  };
}

export interface WorkflowGraph {
  name: string;
  nodes: WorkflowCanvasNode[];
  edges: WorkflowEdgeInput[];
}

export interface WorkflowApp {
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

export interface WorkflowVersion {
  id: string;
  workflowId: string;
  versionNumber: number;
  name: string;
  releaseNotes: string;
  graph: WorkflowGraph;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  createdAt: string;
}

export interface WorkflowDetail {
  app: WorkflowApp;
  draft: WorkflowGraph;
  versions: WorkflowVersion[];
}

export interface WorkflowApiKeyRecord {
  id: string;
  workflowId: string;
  name: string;
  keyHash: string;
  prefix: string;
  status: "ACTIVE" | "REVOKED";
  rateLimitPerMinute: number;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export type WorkflowApiKeyView = Omit<WorkflowApiKeyRecord, "keyHash">;

export type WorkflowRunStatus = "running" | "succeeded" | "failed" | "stopped";

export interface WorkflowRunRecord {
  id: string;
  taskId: string;
  workflowId: string;
  versionId: string | null;
  user: string;
  source: "service-api" | "studio";
  status: WorkflowRunStatus;
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

export interface WorkflowRunSnapshot {
  runId: string;
  graph: WorkflowGraph;
}

export function graphToRunNodes(graph: WorkflowGraph): WorkflowNodeInput[] {
  // DB 里保存的旧草稿/已发布版本仍可能含 kind:"graph"。这里是「版本图 → 执行器」的唯一
  // 入口，先统一迁移成 rag 节点，保证已发布旧版本在升级后仍能运行（迁移幂等）。
  const data = graph.nodes.map((node) => ({
    id: node.id,
    kind: node.data.kind,
    label: node.data.label,
    config: node.data.config,
  }));
  return migrateLegacyGraphNodes(data);
}
