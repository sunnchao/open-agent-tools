import {
  workflowGraphSchema,
  nodeConfigSchemas,
  portableHttpConfig,
} from "@open-agent-tools/workflow-contracts";
import type { Edge } from "@xyflow/react";
import { createEdge, createNode, snapshotGraph } from "./graph.js";
import { cloneSubgraph } from "./subgraph.js";
import { serializeWorkflow, workflowFileSizeLimit } from "./io.js";
import { nodeInputs, nodeOutputs } from "./model.js";
import type { WorkflowNode } from "./types.js";
import { restoreBranchEdge } from "./condition.js";

const format = "open-agent-tools/workflow-selection";

export function assertSelectionSources(nodes: WorkflowNode[], existingNodes: WorkflowNode[]): void {
  const available = new Map([...existingNodes, ...nodes].map((node) => [node.id, node]));
  for (const node of nodes) {
    for (const input of nodeInputs(node.data)) {
      const binding = input.source;
      if (binding.type !== "node") continue;
      const source = available.get(binding.nodeId);
      if (!source || !nodeOutputs(source.data).some((output) => output.name === binding.output))
        throw new Error("剪贴板引用的上游节点在当前工作流中不存在，请同时复制该来源节点后重试");
    }
  }
}

export function serializeSelection(nodes: WorkflowNode[], edges: Edge[], ids: Set<string>): string {
  const selected = nodes.filter((node) => ids.has(node.id));
  if (!selected.length) throw new Error("请先选择节点");
  if (selected.some((node) => node.data.kind === "start"))
    throw new Error("开始节点不能复制，请取消选择开始节点");
  const graph = snapshotGraph(
    "selection",
    selected,
    edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
  );
  // Reuse the portable export allowlist and credential checks for clipboard data.
  const portable = JSON.parse(serializeWorkflow(graph)) as { graph: unknown };
  return JSON.stringify({ format, version: 1, graph: portable.graph });
}

export function parseSelection(text: string): { nodes: WorkflowNode[]; edges: Edge[] } {
  if (new TextEncoder().encode(text).length > workflowFileSizeLimit)
    throw new Error("剪贴板工作流超过 2 MB");
  let value: { format?: string; version?: number; graph?: unknown };
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("剪贴板不是工作流 JSON");
  }
  if (!value || value.format !== format || value.version !== 1)
    throw new Error("剪贴板不含支持的工作流节点");
  const parsed = workflowGraphSchema.safeParse(value.graph);
  if (!parsed.success) throw new Error(`剪贴板节点格式无效：${parsed.error.issues[0]?.message}`);
  if (!parsed.data.nodes.length) throw new Error("剪贴板未包含任何节点");
  const nodes = parsed.data.nodes.map((node, index) => {
    const created = createNode(
      node.id,
      node.data.kind,
      node.position ?? { x: index * 280, y: 0 },
      node.data.kind === "http"
        ? portableHttpConfig(nodeConfigSchemas.http.parse(node.data.config ?? {}))
        : node.data.config,
    );
    created.data.label = node.data.label ?? created.data.label;
    created.data.description = node.data.description ?? created.data.description;
    return created;
  });
  const edges = parsed.data.edges.map((edge) =>
    restoreBranchEdge(
      {
        ...createEdge(edge.source, edge.target),
        ...(edge.label ? { label: edge.label } : {}),
        ...(edge.branchId ? { branchId: edge.branchId } : {}),
      },
      nodes,
    ),
  );
  // Sanitizing before cloning prevents foreign state and secrets from entering the editor.
  serializeWorkflow(snapshotGraph("selection", nodes, edges));
  return cloneSubgraph(nodes, edges, new Set(nodes.map((node) => node.id)));
}
