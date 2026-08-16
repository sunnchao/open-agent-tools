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

export const workflowRouter: ReturnType<typeof Router> = Router();

workflowRouter.post("/api/workflow/run", async (req: Request, res: Response) => {
  const request = req.body as WorkflowRunRequest;
  logTrace("workflow.run", { request });
  try {
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
  req.once("aborted", () => controller.abort());
  res.once("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  try {
    await executeWorkflow(request, (event) => send(event), { signal: controller.signal });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send({
      type: "run_error",
      ...(error instanceof WorkflowNodeError ? { nodeId: error.nodeId } : {}),
      error: message,
    });
  } finally {
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
