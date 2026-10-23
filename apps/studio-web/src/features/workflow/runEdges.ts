import type { Edge } from "@xyflow/react";
import {
  updateRunEdges,
  type EdgeRunStates,
  type EdgeRunStatus,
} from "@open-agent-tools/workflow-contracts";

export { updateRunEdges, type EdgeRunStates, type EdgeRunStatus };

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
