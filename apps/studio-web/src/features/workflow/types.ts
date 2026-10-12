import type { Edge, Node } from "@xyflow/react";
import type { NodeKind, WorkflowNodeData } from "./model.js";
import type { WorkflowTokenUsage } from "../../lib/api.js";
import type { ConditionWarning } from "@open-agent-tools/workflow-contracts";

export type WorkflowNode = Node<WorkflowNodeData, "studio">;
export type WorkflowEdge = Edge & { branchId?: string };
export type WorkflowMobileView = "palette" | "canvas" | "inspector";

export interface NodeTestDialogState {
  nodeId: string;
  values: Record<string, string>;
}

export interface NodePickerState {
  anchor: { x: number; y: number };
  edgeId?: string;
  position: { x: number; y: number };
  sourceNodeId?: string;
  branchId?: string;
}

export interface WorkflowSnapshot {
  name: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface PaletteItem {
  kind: NodeKind;
  label: string;
  description: string;
  group: "输入" | "知识与模型" | "工具与逻辑" | "输出";
}

export interface RunLogEntry {
  id: string;
  label: string;
  kind?: string;
  status: "success" | "error";
  detail?: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  result?: unknown;
  /** LLM 节点插值后的最终请求内容（user 消息）。 */
  prompt?: string;
  /** LLM 节点插值后的系统提示词（system 消息）。 */
  systemPrompt?: string;
  durationMs?: number;
  attempts?: number;
  cached?: boolean;
  incomingEdgeIds?: string[];
  tokenUsage?: WorkflowTokenUsage;
  selectedBranchLabel?: string;
  warnings?: ConditionWarning[];
}
