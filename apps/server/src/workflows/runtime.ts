import { randomUUID } from "node:crypto";
import type { WorkflowResumeCheckpoint } from "@open-agent-tools/workflow-contracts";
import { executeWorkflow, type WorkflowEvent } from "../workflow/executor.js";
import {
  appendWorkflowEvent,
  createWorkflowRun,
  finishWorkflowRun,
  upsertWorkflowNodeRun,
} from "./store.js";
import { workflowRedactor } from "../workflow/redaction.js";
import type {
  WorkflowApp,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowVersion,
} from "./types.js";
import { graphToRunNodes } from "./types.js";

export interface PublicWorkflowEvent extends Record<string, unknown> {
  event: string;
  task_id: string;
  workflow_run_id: string;
  sequence: number;
  data: Record<string, unknown>;
}

export interface PublishedRunResult {
  taskId: string;
  runId: string;
  status: Exclude<WorkflowRunStatus, "running">;
  outputs: Record<string, unknown> | null;
  error: string | null;
  totalSteps: number;
  totalTokens: number;
  elapsedTime: number;
  createdAt: string;
  finishedAt: string;
}

interface ActiveRun {
  workflowId: string;
  runId: string;
  controller: AbortController;
}

const activeRuns = new Map<string, ActiveRun>();

function publicEvent(
  runId: string,
  taskId: string,
  type: string,
  data: Record<string, unknown>,
): PublicWorkflowEvent {
  const stored = appendWorkflowEvent(runId, type, data);
  return {
    event: type,
    task_id: taskId,
    workflow_run_id: runId,
    sequence: stored.sequence,
    data,
  };
}

export function startPublishedWorkflow(input: {
  app: WorkflowApp;
  version?: WorkflowVersion;
  graph?: WorkflowVersion["graph"];
  inputs: Record<string, unknown>;
  user: string;
  source?: WorkflowRunRecord["source"];
  runId?: string;
  taskId?: string;
  signal?: AbortSignal;
  onEvent?: (event: PublicWorkflowEvent) => void;
  onWorkflowEvent?: (event: WorkflowEvent) => void;
  resume?: WorkflowResumeCheckpoint;
  resumeRunId?: string;
}): { taskId: string; runId: string; completion: Promise<PublishedRunResult> } {
  const runId = input.runId ?? randomUUID();
  const taskId = input.taskId ?? randomUUID();
  const createdAt = new Date().toISOString();
  const startedAt = Date.now();
  const controller = new AbortController();
  const sourceGraph = input.graph ?? input.version?.graph;
  if (!sourceGraph) throw new Error("workflow graph is required");
  const graph = structuredClone(sourceGraph);
  const redactor = workflowRedactor(graphToRunNodes(graph), input.inputs);
  const abort = () => controller.abort();
  if (input.signal?.aborted) abort();
  let totalSteps = 0;
  let totalTokens = 0;

  createWorkflowRun(
    {
      id: runId,
      taskId,
      workflowId: input.app.id,
      versionId: input.version?.id ?? null,
      user: input.user,
      source: input.source ?? "service-api",
      status: "running",
      inputs: input.inputs,
      outputs: null,
      error: null,
      totalSteps: 0,
      totalTokens: 0,
      createdAt,
      finishedAt: null,
      elapsedTime: null,
    },
    graph,
  );
  input.signal?.addEventListener("abort", abort, { once: true });
  activeRuns.set(taskId, { workflowId: input.app.id, runId, controller });

  const emitPublic = (event: PublicWorkflowEvent) => input.onEvent?.(event);
  emitPublic(
    publicEvent(runId, taskId, "workflow_started", {
      id: runId,
      workflow_id: input.version?.id ?? null,
      inputs: redactor.redact(input.inputs),
      created_at: createdAt,
      ...(input.resume
        ? { resume_from_node_id: input.resume.fromNodeId, resume_run_id: input.resumeRunId }
        : {}),
    }),
  );

  const completion = (async (): Promise<PublishedRunResult> => {
    let finalNodeOutputs: Record<string, Record<string, unknown>> = {};
    let outputs: Record<string, unknown> = {};
    try {
      await executeWorkflow(
        {
          nodes: graphToRunNodes(graph),
          edges: graph.edges,
          input: input.inputs,
        },
        (event: WorkflowEvent) => {
          if (event.type === "run_done") {
            outputs = event.outputs ?? {};
            finalNodeOutputs = event.nodeOutputs ?? {};
          }
          if (event.type !== "run_done") input.onWorkflowEvent?.(event);
          if (event.type === "node_start" && event.nodeId) {
            upsertWorkflowNodeRun({ runId, nodeId: event.nodeId, status: "running" });
            emitPublic(
              publicEvent(runId, taskId, "node_started", {
                node_id: event.nodeId,
                title: event.label ?? event.nodeId,
                node_type: event.kind ?? "unknown",
                incoming_edge_ids: event.incomingEdgeIds ?? [],
              }),
            );
          }
          if ((event.type === "node_result" || event.type === "node_cached") && event.nodeId) {
            if (event.type === "node_result") totalSteps += 1;
            totalTokens += event.metadata?.tokenUsage.totalTokens ?? 0;
            upsertWorkflowNodeRun({
              runId,
              nodeId: event.nodeId,
              status: event.status ?? "error",
              inputs: event.inputs,
              outputs: event.outputs,
              error: event.error,
              durationMs: event.metadata?.durationMs,
              totalTokens: event.metadata?.tokenUsage.totalTokens,
            });
            emitPublic(
              publicEvent(runId, taskId, "node_finished", {
                node_id: event.nodeId,
                status: event.status,
                inputs: event.inputs,
                outputs: event.outputs,
                result: event.result,
                incoming_edge_ids: event.incomingEdgeIds ?? [],
                prompt: event.prompt,
                systemPrompt: event.systemPrompt,
                error: event.error,
                metadata: event.metadata,
              }),
            );
          }
        },
        { signal: controller.signal, resume: input.resume },
      );

      const elapsedTime = (Date.now() - startedAt) / 1_000;
      const finishedAt = new Date().toISOString();
      finishWorkflowRun({
        runId,
        status: "succeeded",
        outputs,
        totalSteps,
        totalTokens,
        elapsedTime,
      });
      emitPublic(
        publicEvent(runId, taskId, "workflow_finished", {
          id: runId,
          workflow_id: input.version?.id ?? null,
          status: "succeeded",
          outputs,
          elapsed_time: elapsedTime,
          total_steps: totalSteps,
          total_tokens: totalTokens,
          created_at: createdAt,
          finished_at: finishedAt,
        }),
      );
      input.onWorkflowEvent?.({ type: "run_done", outputs, nodeOutputs: finalNodeOutputs });
      return {
        taskId,
        runId,
        status: "succeeded",
        outputs,
        error: null,
        totalSteps,
        totalTokens,
        elapsedTime,
        createdAt,
        finishedAt,
      };
    } catch (error) {
      const stopped = controller.signal.aborted;
      const status = stopped ? "stopped" : "failed";
      const message = stopped
        ? "workflow run stopped"
        : error instanceof Error
          ? error.message
          : String(error);
      const elapsedTime = (Date.now() - startedAt) / 1_000;
      const finishedAt = new Date().toISOString();
      finishWorkflowRun({
        runId,
        status,
        error: message,
        totalSteps,
        totalTokens,
        elapsedTime,
      });
      emitPublic(
        publicEvent(runId, taskId, stopped ? "workflow_finished" : "error", {
          id: runId,
          workflow_id: input.version?.id ?? null,
          status,
          error: message,
          elapsed_time: elapsedTime,
          total_steps: totalSteps,
          total_tokens: totalTokens,
          created_at: createdAt,
          finished_at: finishedAt,
        }),
      );
      return {
        taskId,
        runId,
        status,
        outputs: null,
        error: message,
        totalSteps,
        totalTokens,
        elapsedTime,
        createdAt,
        finishedAt,
      };
    } finally {
      input.signal?.removeEventListener("abort", abort);
      activeRuns.delete(taskId);
    }
  })();

  return { taskId, runId, completion };
}

export function stopPublishedWorkflow(taskId: string, workflowId: string): boolean {
  const active = activeRuns.get(taskId);
  if (!active || active.workflowId !== workflowId) return false;
  active.controller.abort();
  return true;
}

export function clearActiveWorkflowRunsForTest(): void {
  for (const run of activeRuns.values()) run.controller.abort();
  activeRuns.clear();
}
