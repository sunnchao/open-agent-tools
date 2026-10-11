import type { Edge } from "@xyflow/react";
import { createEdge, snapshotGraph } from "./graph.js";
import type { NodeInputBinding } from "./model.js";
import type { WorkflowNode } from "./types.js";

export function cloneSubgraph(
  nodes: WorkflowNode[],
  edges: Edge[],
  selectedIds: Set<string>,
  includeIncoming = false,
  idFactory: () => string = () => crypto.randomUUID(),
): { nodes: WorkflowNode[]; edges: Edge[] } {
  const selected = snapshotGraph(
    "selection",
    nodes.filter((node) => selectedIds.has(node.id)),
    [],
  ).nodes;
  if (selected.some((node) => node.data.kind === "start"))
    throw new Error("开始节点不能复制，请取消选择开始节点");
  const ids = new Map(selected.map((node) => [node.id, `${node.data.kind}-${idFactory()}`]));
  const copies = selected.map((node) => {
    const id = ids.get(node.id)!;
    const inputs = node.data.config.inputs as NodeInputBinding[] | undefined;
    return {
      ...node,
      id,
      selected: true,
      position: { x: node.position.x + 40, y: node.position.y + 40 },
      data: {
        ...node.data,
        id,
        status: "idle" as const,
        config: {
          ...node.data.config,
          ...(inputs
            ? {
                inputs: inputs.map((input) =>
                  input.source.type === "node"
                    ? {
                        ...input,
                        source: {
                          ...input.source,
                          nodeId: ids.get(input.source.nodeId) ?? input.source.nodeId,
                        },
                      }
                    : input,
                ),
              }
            : {}),
        },
      },
    };
  });
  const links = edges
    .filter((edge) => ids.has(edge.target) && (ids.has(edge.source) || includeIncoming))
    .map((edge) => ({
      ...createEdge(ids.get(edge.source) ?? edge.source, ids.get(edge.target)!),
      ...(edge.label !== undefined ? { label: edge.label } : {}),
    }));
  return { nodes: copies, edges: links };
}
