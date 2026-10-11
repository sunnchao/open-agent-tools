import { graphlib, layout } from "@dagrejs/dagre";
import type { Edge } from "@xyflow/react";
import type { WorkflowNode } from "./types.js";

export function layoutWorkflow(nodes: WorkflowNode[], edges: Edge[]): WorkflowNode[] {
  const graph = new graphlib.Graph({ multigraph: true });
  graph.setGraph({ rankdir: "LR", ranksep: 90, nodesep: 60, marginx: 40, marginy: 40 });
  const ids = new Set(nodes.map((node) => node.id));
  for (const node of nodes)
    graph.setNode(node.id, {
      width: node.measured?.width ?? node.width ?? 218,
      height: node.measured?.height ?? node.height ?? 110,
    });
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target))
      throw new Error("连接包含失效节点，请先修复");
    graph.setEdge(edge.source, edge.target, {}, edge.id);
  }
  if (!graphlib.alg.isAcyclic(graph)) throw new Error("工作流包含环，请先修复后整理布局");
  layout(graph);
  return nodes.map((node) => {
    const placed = graph.node(node.id);
    return {
      ...node,
      position: { x: placed.x - placed.width / 2, y: placed.y - placed.height / 2 },
    };
  });
}
