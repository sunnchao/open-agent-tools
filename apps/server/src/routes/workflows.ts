import { createHash, randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { validateWorkflow, WorkflowValidationError } from "../workflow/executor.js";
import { authorizeWorkflowRequest, createWorkflowApiKey } from "../workflows/auth.js";
import { startPublishedWorkflow, stopPublishedWorkflow } from "../workflows/runtime.js";
import {
  createWorkflowOpenApi,
  deriveWorkflowSchemas,
  validatePublishedInputs,
} from "../workflows/schema.js";
import {
  createWorkflow,
  claimWorkflowIdempotency,
  deleteWorkflow,
  duplicateWorkflow,
  getWorkflow,
  getWorkflowBySlug,
  getWorkflowRun,
  getWorkflowRunByTask,
  getWorkflowVersion,
  listWorkflowApiKeys,
  listWorkflowEvents,
  listWorkflowRuns,
  listWorkflows,
  publishWorkflow,
  revokeWorkflowApiKey,
  rollbackWorkflow,
  saveWorkflowDraft,
  WorkflowConflictError,
  WorkflowNotFoundError,
} from "../workflows/store.js";
import type { PublicWorkflowEvent } from "../workflows/runtime.js";
import type { WorkflowGraph, WorkflowRunRecord } from "../workflows/types.js";
import { graphToRunNodes } from "../workflows/types.js";

export const workflowsRouter: ReturnType<typeof Router> = Router();

function sendError(res: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof WorkflowNotFoundError) {
    res.status(404).json({ error: message });
    return;
  }
  if (error instanceof WorkflowConflictError) {
    res.status(409).json({ error: message });
    return;
  }
  if (error instanceof WorkflowValidationError) {
    res.status(400).json({ error: message });
    return;
  }
  res.status(400).json({ error: message });
}

function graphFromBody(value: unknown): WorkflowGraph {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkflowValidationError("workflow graph is required");
  }
  const graph = value as Partial<WorkflowGraph>;
  if (
    typeof graph.name !== "string" ||
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.edges)
  ) {
    throw new WorkflowValidationError("workflow graph requires name, nodes, and edges");
  }
  if (
    graph.nodes.some(
      (node) =>
        !node || typeof node.id !== "string" || !node.data || typeof node.data.kind !== "string",
    ) ||
    graph.edges.some(
      (edge) => !edge || typeof edge.source !== "string" || typeof edge.target !== "string",
    )
  ) {
    throw new WorkflowValidationError("workflow nodes and edges require valid identities");
  }
  return graph as WorkflowGraph;
}

function validateGraph(graph: WorkflowGraph): void {
  validateWorkflow({ nodes: graphToRunNodes(graph), edges: graph.edges, input: {} });
}

function publicOrigin(req: Request): string {
  return (
    process.env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") ?? `${req.protocol}://${req.get("host")}`
  );
}

function publishedVersionForSlug(slug: string) {
  const app = getWorkflowBySlug(slug);
  if (!app) throw new WorkflowNotFoundError("workflow not found");
  if (!app.currentVersionId) throw new WorkflowConflictError("workflow has not been published");
  const version = getWorkflowVersion(app.currentVersionId);
  if (!version) throw new WorkflowConflictError("published workflow version is unavailable");
  return { app, version };
}

async function authorize(req: Request, res: Response, workflowId: string): Promise<boolean> {
  const result = await authorizeWorkflowRequest(req, workflowId);
  if (result.ok) return true;
  res.status(result.status).json({ error: result.error });
  return false;
}

function blockingResponse(
  run: {
    taskId: string;
    runId: string;
    status: string;
    outputs: Record<string, unknown> | null;
    error: string | null;
    totalSteps: number;
    totalTokens: number;
    elapsedTime: number;
    createdAt: string;
    finishedAt: string;
  },
  versionId: string,
) {
  return {
    task_id: run.taskId,
    workflow_run_id: run.runId,
    data: {
      id: run.runId,
      workflow_id: versionId,
      status: run.status,
      outputs: run.outputs,
      error: run.error,
      elapsed_time: run.elapsedTime,
      total_steps: run.totalSteps,
      total_tokens: run.totalTokens,
      created_at: run.createdAt,
      finished_at: run.finishedAt,
    },
  };
}

function blockingResponseFromRecord(run: WorkflowRunRecord) {
  return {
    task_id: run.taskId,
    workflow_run_id: run.id,
    data: {
      id: run.id,
      workflow_id: run.versionId,
      status: run.status,
      outputs: run.outputs,
      error: run.error,
      elapsed_time: run.elapsedTime,
      total_steps: run.totalSteps,
      total_tokens: run.totalTokens,
      created_at: run.createdAt,
      finished_at: run.finishedAt,
    },
  };
}

workflowsRouter.get("/api/workflows", (_req, res) => {
  res.json({ workflows: listWorkflows() });
});

workflowsRouter.post("/api/workflows", (req, res) => {
  try {
    const name = typeof req.body?.name === "string" ? req.body.name : "未命名工作流";
    const graph = req.body?.graph === undefined ? undefined : graphFromBody(req.body.graph);
    if (graph) validateGraph(graph);
    const workflow = createWorkflow({
      name,
      description: typeof req.body?.description === "string" ? req.body.description : "",
      graph,
    });
    res.status(201).json({ workflow });
  } catch (error) {
    sendError(res, error);
  }
});

workflowsRouter.get("/api/workflows/:workflowId", (req, res) => {
  const workflow = getWorkflow(String(req.params.workflowId));
  if (!workflow) {
    res.status(404).json({ error: "workflow not found" });
    return;
  }
  res.json({ workflow, apiKeys: listWorkflowApiKeys(workflow.app.id) });
});

workflowsRouter.put("/api/workflows/:workflowId/draft", (req, res) => {
  try {
    // Drafts may contain unfinished bindings. Execution and publication validate references.
    const graph = graphFromBody(req.body?.graph);
    const expectedRevision = Number(req.body?.expectedRevision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new WorkflowValidationError("expectedRevision must be a positive integer");
    }
    const workflow = saveWorkflowDraft(String(req.params.workflowId), expectedRevision, graph);
    res.json({ workflow });
  } catch (error) {
    sendError(res, error);
  }
});

workflowsRouter.post("/api/workflows/:workflowId/validate", (req, res) => {
  try {
    const graph = req.body?.graph
      ? graphFromBody(req.body.graph)
      : getWorkflow(String(req.params.workflowId))?.draft;
    if (!graph) throw new WorkflowNotFoundError("workflow not found");
    validateGraph(graph);
    const schemas = deriveWorkflowSchemas(graph);
    res.json({ valid: true, issues: [], ...schemas });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(error instanceof WorkflowNotFoundError ? 404 : 400).json({
      valid: false,
      issues: [{ code: "workflow-invalid", message }],
    });
  }
});

workflowsRouter.post("/api/workflows/:workflowId/publish", (req, res) => {
  try {
    const workflowId = String(req.params.workflowId);
    const detail = getWorkflow(workflowId);
    if (!detail) throw new WorkflowNotFoundError("workflow not found");
    validateGraph(detail.draft);
    const schemas = deriveWorkflowSchemas(detail.draft);
    const version = publishWorkflow({
      workflowId,
      expectedRevision: Number(req.body?.expectedRevision),
      releaseNotes: typeof req.body?.releaseNotes === "string" ? req.body.releaseNotes : "",
      ...schemas,
    });
    res.status(201).json({ version, workflow: getWorkflow(workflowId) });
  } catch (error) {
    sendError(res, error);
  }
});

workflowsRouter.post("/api/workflows/:workflowId/rollback", (req, res) => {
  try {
    if (typeof req.body?.versionId !== "string") {
      throw new WorkflowValidationError("versionId is required");
    }
    res.json({
      workflow: rollbackWorkflow(String(req.params.workflowId), req.body.versionId),
    });
  } catch (error) {
    sendError(res, error);
  }
});

workflowsRouter.post("/api/workflows/:workflowId/duplicate", (req, res) => {
  try {
    res.status(201).json({ workflow: duplicateWorkflow(String(req.params.workflowId)) });
  } catch (error) {
    sendError(res, error);
  }
});

workflowsRouter.delete("/api/workflows/:workflowId", (req, res) => {
  if (!deleteWorkflow(String(req.params.workflowId))) {
    res.status(404).json({ error: "workflow not found" });
    return;
  }
  res.status(204).end();
});

workflowsRouter.get("/api/workflows/:workflowId/api-keys", (req, res) => {
  res.json({ apiKeys: listWorkflowApiKeys(String(req.params.workflowId)) });
});

workflowsRouter.post("/api/workflows/:workflowId/api-keys", async (req, res) => {
  try {
    const workflowId = String(req.params.workflowId);
    if (!getWorkflow(workflowId)) throw new WorkflowNotFoundError("workflow not found");
    const created = await createWorkflowApiKey({
      workflowId,
      name: typeof req.body?.name === "string" ? req.body.name : "Default",
      rateLimitPerMinute: Number(req.body?.rateLimitPerMinute) || 60,
      expiresAt: typeof req.body?.expiresAt === "string" ? req.body.expiresAt : null,
    });
    res.status(201).json(created);
  } catch (error) {
    sendError(res, error);
  }
});

workflowsRouter.delete("/api/workflows/:workflowId/api-keys/:keyId", (req, res) => {
  if (!revokeWorkflowApiKey(String(req.params.workflowId), String(req.params.keyId))) {
    res.status(404).json({ error: "workflow API key not found" });
    return;
  }
  res.status(204).end();
});

workflowsRouter.get("/api/workflows/:workflowId/openapi.json", (req, res) => {
  try {
    const detail = getWorkflow(String(req.params.workflowId));
    if (!detail) throw new WorkflowNotFoundError("workflow not found");
    if (!detail.app.currentVersionId)
      throw new WorkflowConflictError("workflow has not been published");
    const version = getWorkflowVersion(detail.app.currentVersionId)!;
    res.json(
      createWorkflowOpenApi(
        publicOrigin(req),
        detail.app.slug,
        detail.app.name,
        version.inputSchema,
        version.outputSchema,
      ),
    );
  } catch (error) {
    sendError(res, error);
  }
});

workflowsRouter.get("/api/workflows/:workflowId/runs", (req, res) => {
  const workflow = getWorkflow(String(req.params.workflowId));
  if (!workflow) {
    res.status(404).json({ error: "workflow not found" });
    return;
  }
  res.json({ runs: listWorkflowRuns(workflow.app.id, Number(req.query.limit) || 50) });
});

workflowsRouter.post("/v1/workflows/:slug/run", async (req, res) => {
  try {
    const { app, version } = publishedVersionForSlug(String(req.params.slug));
    if (!(await authorize(req, res, app.id))) return;
    const inputs = req.body?.inputs;
    const user = req.body?.user;
    if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) {
      res.status(400).json({ error: "inputs must be an object" });
      return;
    }
    if (typeof user !== "string" || !user.trim()) {
      res.status(400).json({ error: "user is required" });
      return;
    }
    if (user.length > 200) {
      res.status(400).json({ error: "user must not exceed 200 characters" });
      return;
    }
    if (
      req.body?.response_mode !== undefined &&
      req.body.response_mode !== "blocking" &&
      req.body.response_mode !== "streaming"
    ) {
      res.status(400).json({ error: "response_mode must be blocking or streaming" });
      return;
    }
    const inputErrors = validatePublishedInputs(version.inputSchema, inputs);
    if (inputErrors.length > 0) {
      res.status(400).json({ error: inputErrors.join("; ") });
      return;
    }
    const responseMode = req.body?.response_mode === "streaming" ? "streaming" : "blocking";
    const runId = randomUUID();
    const taskId = randomUUID();
    const idempotencyKey = req.header("idempotency-key")?.trim();
    if (idempotencyKey) {
      if (idempotencyKey.length > 200) {
        res.status(400).json({ error: "Idempotency-Key must not exceed 200 characters" });
        return;
      }
      const requestHash = createHash("sha256")
        .update(JSON.stringify({ workflowVersionId: version.id, inputs, user: user.trim() }))
        .digest("hex");
      const claim = claimWorkflowIdempotency({
        workflowId: app.id,
        idempotencyKey,
        requestHash,
        runId,
      });
      if (!claim.claimed) {
        if (claim.requestHash !== requestHash) {
          res
            .status(409)
            .json({ error: "Idempotency-Key was already used with a different request" });
          return;
        }
        const existing = getWorkflowRun(claim.runId);
        if (existing && existing.status !== "running" && responseMode === "blocking") {
          res.json(blockingResponseFromRecord(existing));
          return;
        }
        res.status(409).json({
          error: "workflow request already exists",
          workflow_run_id: claim.runId,
          status: existing?.status ?? "pending",
        });
        return;
      }
    }
    if (responseMode === "streaming") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      res.write("event: ping\n\n");
      const heartbeat = setInterval(() => {
        if (!res.writableEnded && !res.destroyed) res.write("event: ping\n\n");
      }, 10_000);
      const run = startPublishedWorkflow({
        app,
        version,
        inputs,
        user: user.trim(),
        runId,
        taskId,
        onEvent: (event: PublicWorkflowEvent) => {
          if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
        },
      });
      await run.completion;
      clearInterval(heartbeat);
      res.end();
      return;
    }
    const run = startPublishedWorkflow({
      app,
      version,
      inputs,
      user: user.trim(),
      runId,
      taskId,
    });
    const result = await run.completion;
    res.json(blockingResponse(result, version.id));
  } catch (error) {
    if (!res.headersSent) sendError(res, error);
    else res.end();
  }
});

workflowsRouter.post("/v1/workflow-tasks/:taskId/stop", async (req, res) => {
  const run = getWorkflowRunByTask(String(req.params.taskId));
  if (!run) {
    res.status(404).json({ error: "workflow task not found" });
    return;
  }
  if (!(await authorize(req, res, run.workflowId))) return;
  if (!stopPublishedWorkflow(run.taskId, run.workflowId)) {
    res.status(409).json({ error: "workflow task is no longer running" });
    return;
  }
  res.json({ result: "success" });
});

workflowsRouter.get("/v1/workflow-runs/:runId", async (req, res) => {
  const run = getWorkflowRun(String(req.params.runId));
  if (!run) {
    res.status(404).json({ error: "workflow run not found" });
    return;
  }
  if (!(await authorize(req, res, run.workflowId))) return;
  res.json(run);
});

workflowsRouter.get("/v1/workflow-runs/:runId/events", async (req, res) => {
  const run = getWorkflowRun(String(req.params.runId));
  if (!run) {
    res.status(404).json({ error: "workflow run not found" });
    return;
  }
  if (!(await authorize(req, res, run.workflowId))) return;
  const after = Number(req.query.after) || 0;
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.write("event: ping\n\n");
  for (const event of listWorkflowEvents(run.id, after)) {
    res.write(
      `data: ${JSON.stringify({
        event: event.type,
        task_id: run.taskId,
        workflow_run_id: run.id,
        sequence: event.sequence,
        data: event.payload,
      })}\n\n`,
    );
  }
  res.end();
});

workflowsRouter.get("/v1/workflows/:slug/schema", async (req, res) => {
  try {
    const { app, version } = publishedVersionForSlug(String(req.params.slug));
    if (!(await authorize(req, res, app.id))) return;
    res.json({
      workflow_id: version.id,
      input_schema: version.inputSchema,
      output_schema: version.outputSchema,
    });
  } catch (error) {
    sendError(res, error);
  }
});
