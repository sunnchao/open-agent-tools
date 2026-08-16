import { MarkerType, type Edge } from "@xyflow/react";
import { defaultConfig, migrateNodeData } from "../../features/workflow/model.js";
import type {
  NodeKind,
  WorkflowConfigValue,
} from "../../features/workflow/model.js";
import { palette } from "./palette.js";
import type { WorkflowNode, WorkflowSnapshot } from "./types.js";

export const storageKey = "open-agent-tools.workflow.v1";
export const historyLimit = 50;

export function createNode(
  id: string,
  kind: NodeKind,
  position: { x: number; y: number },
  config?: Record<string, WorkflowConfigValue>,
): WorkflowNode {
  const definition = palette.find((item) => item.kind === kind)!;
  return {
    id,
    type: "studio",
    position,
    data: {
      id,
      kind,
      label: definition.label,
      description: definition.description,
      status: "idle",
      config: { ...defaultConfig(kind), ...config },
    },
  };
}

export function createEdge(source: string, target: string): Edge {
  return {
    id: `edge-${source}-${target}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    source,
    target,
    type: "studio",
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
  };
}

export function loadSavedGraph(): { name: string; nodes: WorkflowNode[]; edges: Edge[] } | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const saved = JSON.parse(raw) as { name: string; nodes: WorkflowNode[]; edges: Edge[] };
    return {
      ...saved,
      nodes: saved.nodes.map((node) => ({ ...node, data: migrateNodeData(node.data, node.id) })),
      edges: saved.edges.map((edge) => ({ ...edge, type: "studio" })),
    };
  } catch {
    return null;
  }
}

export function snapshotGraph(name: string, nodes: WorkflowNode[], edges: Edge[]): WorkflowSnapshot {
  return {
    name,
    nodes: nodes.map((node) => ({
      id: node.id,
      type: "studio",
      position: { ...node.position },
      data: {
        ...node.data,
        status: "idle",
        config: JSON.parse(JSON.stringify(node.data.config)) as Record<string, WorkflowConfigValue>,
      },
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: "studio",
      ...(edge.label !== undefined ? { label: edge.label } : {}),
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
    })),
  };
}

export function snapshotKey(snapshot: WorkflowSnapshot): string {
  return JSON.stringify(snapshot);
}

export const initialNodes: WorkflowNode[] = [
  createNode("start-1", "start", { x: 80, y: 260 }),
  createNode("input-1", "input", { x: 350, y: 260 }),
  createNode(
    "rag-1",
    "rag",
    { x: 620, y: 180 },
    {
      inputs: [
        {
          name: "query",
          source: { type: "node", nodeId: "input-1", output: "query" },
          required: true,
        },
      ],
      outputs: [{ name: "context", selector: "$result" }],
    },
  ),
  createNode(
    "llm-1",
    "llm",
    { x: 890, y: 260 },
    {
      inputs: [
        {
          name: "context",
          source: { type: "node", nodeId: "rag-1", output: "context" },
          required: true,
        },
      ],
    },
  ),
  createNode(
    "end-1",
    "end",
    { x: 1160, y: 260 },
    {
      inputs: [
        {
          name: "answer",
          source: { type: "node", nodeId: "llm-1", output: "answer" },
          required: true,
        },
      ],
      outputs: [{ name: "answer", selector: "$inputs.answer" }],
    },
  ),
];

export const initialEdges: Edge[] = [
  createEdge("start-1", "input-1"),
  createEdge("input-1", "rag-1"),
  createEdge("rag-1", "llm-1"),
  createEdge("llm-1", "end-1"),
];
