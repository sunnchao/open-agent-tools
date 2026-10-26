import type { PublicWorkflowEvent } from "./library/runtime.js";
import type { WorkflowGraph, WorkflowRunRecord } from "./library/types.js";
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
} from "./runtime/executor.js";
import { logTrace } from "../../platform/trace.js";
import { writeSseData } from "../../http/sse.js";
import { workflowRedactor } from "./runtime/redaction.js";
import {
  getWorkflow,
  getWorkflowRun,
  getWorkflowRunSnapshot,
  getWorkflowVersion,
  listWorkflowEvents,
  createWorkflow,
  claimWorkflowIdempotency,
  deleteWorkflow,
  duplicateWorkflow,
  getWorkflowBySlug,
  getWorkflowRunByTask,
  listWorkflowApiKeys,
  listWorkflowRuns,
  listWorkflows,
  publishWorkflow,
  revokeWorkflowApiKey,
  rollbackWorkflow,
  saveWorkflowDraft,
  WorkflowConflictError,
  WorkflowNotFoundError,
} from "./library/store.js";
import { startPublishedWorkflow, stopPublishedWorkflow } from "./library/runtime.js";
import { graphToRunNodes } from "./library/types.js";
import {
  cachedNodesFromEvents,
  migrateLegacyGraphNodes,
  prepareResumeCheckpoint,
  type WorkflowResumeCheckpoint,
  workflowGraphSchema,
} from "@open-agent-tools/workflow-contracts";
import { createHash, randomUUID } from "node:crypto";
import { authorizeWorkflowRequest, createWorkflowApiKey } from "./library/auth.js";
import {
  createWorkflowOpenApi,
  deriveWorkflowSchemas,
  validatePublishedInputs,
} from "./library/schema.js";

/**
 * 工作流 HTTP 层。
 *
 * 两段职责不同，但共用同一个 router 与挂载点（app.ts 无前缀挂载）：
 * - Studio 编辑面：`/api/workflow/*`，直接提交图执行与单节点调试，走 studioAuth 的 run scope。
 * - 资产与公开 API：`/api/workflows/*`（草稿/版本/API Key/运行历史）与 `/v1/*`
 *   （API Key 鉴权 + 限流 + 幂等），`/v1/*` 在 studioAuth 中显式豁免。
 */
export const workflowRouter: ReturnType<typeof Router> = Router();

// ---------------------------------------------------------------------------
// 资产与公开 API（原 routes/public.ts）
// ---------------------------------------------------------------------------

function observedRun(run: WorkflowRunRecord, graph?: WorkflowGraph): WorkflowRunRecord {
  const snapshot =
    graph ??
    getWorkflowRunSnapshot(run.id) ??
    (run.versionId ? getWorkflowVersion(run.versionId)?.graph : undefined);
  if (!snapshot) return run;
  const redact = workflowRedactor(graphToRunNodes(snapshot), run.inputs).redact;
  return {
    ...run,
    inputs: redact(run.inputs),
    outputs: redact(run.outputs),
    error: redact(run.error),
  };
}

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
  const parsed = workflowGraphSchema.safeParse(value);
  if (!parsed.success)
    throw new WorkflowValidationError(
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    );
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

function validateGraph(graph: WorkflowGraph, allowMissingHttpAuth = false): void {
  validateWorkflow(
    { nodes: graphToRunNodes(graph), edges: graph.edges, input: {} },
    { allowMissingHttpAuth },
  );
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

workflowRouter.get("/api/workflows", (_req, res) => {
  res.json({ workflows: listWorkflows() });
});

workflowRouter.post("/api/workflows", (req, res) => {
  try {
    const name = typeof req.body?.name === "string" ? req.body.name : "未命名工作流";
    const graph = req.body?.graph === undefined ? undefined : graphFromBody(req.body.graph);
    if (graph) validateGraph(graph, true);
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

workflowRouter.get("/api/workflows/:workflowId", (req, res) => {
  const workflow = getWorkflow(String(req.params.workflowId));
  if (!workflow) {
    res.status(404).json({ error: "workflow not found" });
    return;
  }
  res.json({ workflow, apiKeys: listWorkflowApiKeys(workflow.app.id) });
});

workflowRouter.put("/api/workflows/:workflowId/draft", (req, res) => {
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

workflowRouter.post("/api/workflows/:workflowId/validate", (req, res) => {
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

workflowRouter.post("/api/workflows/:workflowId/publish", (req, res) => {
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

workflowRouter.post("/api/workflows/:workflowId/rollback", (req, res) => {
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

workflowRouter.post("/api/workflows/:workflowId/duplicate", (req, res) => {
  try {
    res.status(201).json({ workflow: duplicateWorkflow(String(req.params.workflowId)) });
  } catch (error) {
    sendError(res, error);
  }
});

workflowRouter.delete("/api/workflows/:workflowId", (req, res) => {
  if (!deleteWorkflow(String(req.params.workflowId))) {
    res.status(404).json({ error: "workflow not found" });
    return;
  }
  res.status(204).end();
});

workflowRouter.get("/api/workflows/:workflowId/api-keys", (req, res) => {
  res.json({ apiKeys: listWorkflowApiKeys(String(req.params.workflowId)) });
});

workflowRouter.post("/api/workflows/:workflowId/api-keys", async (req, res) => {
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

workflowRouter.delete("/api/workflows/:workflowId/api-keys/:keyId", (req, res) => {
  if (!revokeWorkflowApiKey(String(req.params.workflowId), String(req.params.keyId))) {
    res.status(404).json({ error: "workflow API key not found" });
    return;
  }
  res.status(204).end();
});

workflowRouter.get("/api/workflows/:workflowId/openapi.json", (req, res) => {
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

workflowRouter.get("/api/workflows/:workflowId/runs", (req, res) => {
  const workflow = getWorkflow(String(req.params.workflowId));
  if (!workflow) {
    res.status(404).json({ error: "workflow not found" });
    return;
  }
  res.json({
    runs: listWorkflowRuns(workflow.app.id, Number(req.query.limit) || 50).map((run) =>
      observedRun(run),
    ),
  });
});
workflowRouter.get("/api/workflows/:workflowId/runs/:runId/events", (req, res) => {
  const workflow = getWorkflow(String(req.params.workflowId));
  const run = getWorkflowRun(String(req.params.runId));
  if (!workflow || !run || run.workflowId !== workflow.app.id) {
    res.status(404).json({ error: "workflow run not found" });
    return;
  }
  const rawAfter = req.query.after;
  const after = rawAfter === undefined ? 0 : Number(rawAfter);
  if (!Number.isInteger(after) || after < 0) {
    res.status(400).json({ error: "after must be a non-negative integer" });
    return;
  }
  const graph =
    getWorkflowRunSnapshot(run.id) ??
    (run.versionId ? getWorkflowVersion(run.versionId)?.graph : null);
  if (!graph) {
    res.status(404).json({ error: "workflow run graph not found" });
    return;
  }
  res.json({ run: observedRun(run, graph), events: listWorkflowEvents(run.id, after), graph });
});

workflowRouter.post("/v1/workflows/:slug/run", async (req, res) => {
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
          if (!res.writableEnded && !res.destroyed) writeSseData(res, event);
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

workflowRouter.post("/v1/workflow-tasks/:taskId/stop", async (req, res) => {
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

workflowRouter.get("/v1/workflow-runs/:runId", async (req, res) => {
  const run = getWorkflowRun(String(req.params.runId));
  if (!run) {
    res.status(404).json({ error: "workflow run not found" });
    return;
  }
  if (!(await authorize(req, res, run.workflowId))) return;
  res.json(observedRun(run));
});

workflowRouter.get("/v1/workflow-runs/:runId/events", async (req, res) => {
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
    writeSseData(res, {
      event: event.type,
      task_id: run.taskId,
      workflow_run_id: run.id,
      sequence: event.sequence,
      data: event.payload,
    });
  }
  res.end();
});

workflowRouter.get("/v1/workflows/:slug/schema", async (req, res) => {
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

// ---------------------------------------------------------------------------
// Studio 编辑面（原 routes/studio.ts）
// ---------------------------------------------------------------------------

workflowRouter.post("/api/workflow/run", async (req: Request, res: Response) => {
  let request = req.body as WorkflowRunRequest & { workflowId?: unknown; resume?: unknown };
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    res.status(400).json({ error: "workflow request is required" });
    return;
  }
  // 旧草稿可能仍带 kind:"graph" 节点。这里在进入续跑比对与执行前统一迁移，
  // 否则 resume 会把「未迁移的当前节点」与「已迁移的历史快照」判成节点已修改。
  if (Array.isArray(request.nodes)) {
    request = { ...request, nodes: migrateLegacyGraphNodes(request.nodes) };
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
    writeSseData(res, event);
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
