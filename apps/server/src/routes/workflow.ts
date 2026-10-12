import { Router, type Request, type Response } from "express";
import {
  executeWorkflowNodeTest,
  executeWorkflow,
  validateWorkflow,
  WorkflowNodeError,
  WorkflowValidationError,
  type WorkflowEvent,
  type WorkflowNodeTestRequest,
  type WorkflowRunRequest,
} from "../workflow/executor.js";
import { logTrace } from "../trace.js";
import { workflowRedactor } from "../workflow/redaction.js";
import {
  getWorkflow,
  getWorkflowRun,
  getWorkflowRunSnapshot,
  getWorkflowVersion,
  listWorkflowEvents,
} from "../workflows/store.js";
import { startPublishedWorkflow } from "../workflows/runtime.js";
import { graphToRunNodes } from "../workflows/types.js";
import {
  cachedNodesFromEvents,
  prepareResumeCheckpoint,
  type WorkflowResumeCheckpoint,
} from "@open-agent-tools/workflow-contracts";

export const workflowRouter: ReturnType<typeof Router> = Router();

workflowRouter.post("/api/workflow/run", async (req: Request, res: Response) => {
  let request = req.body as WorkflowRunRequest & { workflowId?: unknown; resume?: unknown };
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    res.status(400).json({ error: "workflow request is required" });
    return;
  }
  let workflow: ReturnType<typeof getWorkflow> = null;
  if (request.workflowId !== undefined) {
    if (typeof request.workflowId !== "string" || !request.workflowId.trim()) {
      res.status(400).json({ error: "workflowId must be a non-empty string" });
      return;
    }
    workflow = getWorkflow(request.workflowId);
    if (!workflow) {
      res.status(404).json({ error: "workflow not found" });
      return;
    }
  }
  logTrace(
    "workflow.run",
    workflowRedactor(Array.isArray(request.nodes) ? request.nodes : [], request.input ?? {}).redact(
      { request },
    ),
  );
  let resume: WorkflowResumeCheckpoint | undefined;
  let resumeRunId: string | undefined;
  try {
    if (request.resume !== undefined) {
      const source = request.resume as { runId?: unknown; fromNodeId?: unknown };
      if (
        !workflow ||
        !source ||
        typeof source.runId !== "string" ||
        typeof source.fromNodeId !== "string" ||
        Object.keys(source).some((key) => !["runId", "fromNodeId"].includes(key))
      )
        throw new WorkflowValidationError("resume requires workflowId, runId and fromNodeId");
      const run = getWorkflowRun(source.runId);
      if (!run || run.workflowId !== workflow.app.id) {
        res.status(404).json({ error: "resume run not found" });
        return;
      }
      if (run.status === "running")
        throw new WorkflowValidationError("cannot resume an active run");
      const graph =
        getWorkflowRunSnapshot(run.id) ??
        (run.versionId ? getWorkflowVersion(run.versionId)?.graph : undefined);
      if (!graph) throw new WorkflowValidationError("resume snapshot is unavailable");
      validateWorkflow(request);
      resume = prepareResumeCheckpoint(
        { nodes: request.nodes, edges: request.edges },
        { nodes: graphToRunNodes(graph), edges: graph.edges },
        source.fromNodeId,
        cachedNodesFromEvents(listWorkflowEvents(run.id)),
      );
      resumeRunId = run.id;
      request = { ...request, input: run.inputs };
    }
    validateWorkflow(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res
      .status(error instanceof WorkflowValidationError ? error.statusCode : 400)
      .json({ error: message });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (event: WorkflowEvent) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const controller = new AbortController();
  let finished = false;
  req.once("aborted", () => controller.abort());
  res.once("close", () => {
    if (!finished) controller.abort();
  });
  try {
    if (workflow) {
      const run = startPublishedWorkflow({
        app: workflow.app,
        graph: {
          name: workflow.app.name,
          nodes: request.nodes.map((node) => ({
            id: node.id,
            type: "studio",
            position: workflow.draft.nodes.find((saved) => saved.id === node.id)?.position,
            data: { id: node.id, kind: node.kind, label: node.label, config: node.config },
          })),
          edges: request.edges,
        },
        inputs: request.input,
        user: "studio",
        source: "studio",
        signal: controller.signal,
        onWorkflowEvent: send,
        resume,
        resumeRunId,
      });
      const result = await run.completion;
      if (result.status !== "succeeded") {
        send({ type: "run_error", error: result.error ?? "Workflow execution failed" });
      }
    } else {
      await executeWorkflow(request, (event) => send(event), { signal: controller.signal });
    }
    finished = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send({
      type: "run_error",
      ...(error instanceof WorkflowNodeError ? { nodeId: error.nodeId } : {}),
      error: message,
    });
  } finally {
    finished = true;
    res.end();
  }
});

workflowRouter.post("/api/workflow/node/test", async (req: Request, res: Response) => {
  const controller = new AbortController();
  req.once("aborted", () => controller.abort());
  try {
    const result = await executeWorkflowNodeTest(req.body as WorkflowNodeTestRequest, {
      signal: controller.signal,
    });
    res.json({ result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res
      .status(error instanceof WorkflowValidationError ? error.statusCode : 400)
      .json({ error: message });
  }
});
