import type { WorkflowNodeRunMeta } from "../../lib/api.js";
import type { WorkflowRunHistory } from "./api.js";
import type { RunLogEntry } from "./types.js";

/** Persisted public events use snake_case; reconstruct the same log shape as Studio SSE. */
export function replayWorkflowRun(history: WorkflowRunHistory): {
  log: RunLogEntry[];
  outputs: Record<string, unknown> | null;
  nodeOutputs: Record<string, Record<string, unknown>>;
} {
  const graphNodes = new Map(history.graph.nodes.map((node) => [node.id, node]));
  const starts = new Map<string, { label: string; kind?: string }>();
  const outputs: Record<string, Record<string, unknown>> = {};
  const log: RunLogEntry[] = [];
  const seen = new Set<number>();
  for (const event of [...history.events].sort((a, b) => a.sequence - b.sequence)) {
    if (seen.has(event.sequence)) continue;
    seen.add(event.sequence);
    const data = event.payload;
    const nodeId = typeof data.node_id === "string" ? data.node_id : null;
    if (event.type === "node_started" && nodeId) {
      starts.set(nodeId, {
        label: typeof data.title === "string" ? data.title : nodeId,
        kind: typeof data.node_type === "string" ? data.node_type : undefined,
      });
    }
    if (event.type !== "node_finished" || !nodeId) continue;
    const node = graphNodes.get(nodeId);
    const started = starts.get(nodeId);
    const meta = data as WorkflowNodeRunMeta & { incoming_edge_ids?: unknown };
    log.push({
      id: nodeId,
      label: started?.label ?? node?.data.label ?? nodeId,
      kind: started?.kind ?? node?.data.kind,
      status: data.status === "success" ? "success" : "error",
      detail: typeof data.error === "string" ? data.error : undefined,
      inputs: meta.inputs,
      outputs: meta.outputs,
      result: meta.result,
      prompt: typeof data.prompt === "string" ? data.prompt : undefined,
      systemPrompt: typeof data.systemPrompt === "string" ? data.systemPrompt : undefined,
      durationMs: meta.metadata?.durationMs,
      attempts: meta.metadata?.attempts,
      cached: meta.metadata?.cached,
      tokenUsage: meta.metadata?.tokenUsage,
      selectedBranchLabel: meta.metadata?.selectedBranchLabel,
      warnings: meta.metadata?.warnings,
      incomingEdgeIds: Array.isArray(data.incoming_edge_ids)
        ? data.incoming_edge_ids.filter((id): id is string => typeof id === "string")
        : undefined,
    });
    if (meta.outputs)
      Object.defineProperty(outputs, nodeId, { value: meta.outputs, enumerable: true });
  }
  if (history.run.error && !log.some((item) => item.detail === history.run.error)) {
    log.push({
      id: `run-${history.run.id}`,
      label: "Workflow",
      status: "error",
      detail: history.run.error,
    });
  }
  return {
    log,
    outputs: history.run.status === "succeeded" ? (history.run.outputs ?? {}) : null,
    nodeOutputs: outputs,
  };
}
