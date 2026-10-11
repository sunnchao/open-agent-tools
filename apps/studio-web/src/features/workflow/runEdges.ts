import type { Edge } from "@xyflow/react";

export type EdgeRunStatus = "active" | "done" | "error";
export type EdgeRunStates = Record<string, EdgeRunStatus>;

export function updateRunEdges(
  current: EdgeRunStates,
  incomingEdgeIds: string[],
  status: EdgeRunStatus,
): EdgeRunStates {
  const next = { ...current };
  for (const id of incomingEdgeIds) next[id] = status;
  return next;
}

export function decorateRunEdges(edges: Edge[], states: EdgeRunStates): Edge[] {
  return edges.map((edge) => {
    const status = states[edge.id];
    return {
      ...edge,
      animated: status === "active",
      data: { ...edge.data, runStatus: status },
      className: status ? `workflow-edge is-${status}` : undefined,
    };
  });
}
