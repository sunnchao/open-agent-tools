export type EdgeRunStatus = "active" | "done" | "error";
export type EdgeRunStates = Record<string, EdgeRunStatus>;

export function updateRunEdges(
  current: EdgeRunStates,
  incomingEdgeIds: readonly string[],
  status: EdgeRunStatus,
): EdgeRunStates {
  const next = { ...current };
  for (const id of incomingEdgeIds) next[id] = status;
  return next;
}
