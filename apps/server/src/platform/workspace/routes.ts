import { Router, type Request, type Response } from "express";
import { logTrace } from "../trace.js";
import { createWorkspace, listWorkspaces } from "./store.js";

export const workspacesRouter: ReturnType<typeof Router> = Router();

/** 列出全部 workspace（含默认空间，默认空间排在最前）。 */
workspacesRouter.get("/api/admin/workspaces", (_req: Request, res: Response) => {
  const workspaces = listWorkspaces();
  res.json({ workspaces });
});

/**
 * 新建 workspace。
 *
 * 只做归属分层，不做成员与权限——那是完整多租户的范畴，当前刻意不引入。
 */
workspacesRouter.post("/api/admin/workspaces", (req: Request, res: Response) => {
  const body = req.body as { name?: unknown; description?: unknown } | undefined;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) {
    res.status(400).json({ error: "workspace name is required" });
    return;
  }
  try {
    const workspace = createWorkspace({
      name,
      ...(typeof body?.description === "string" ? { description: body.description } : {}),
    });
    logTrace("workspace.created", { workspaceId: workspace.id, name: workspace.name });
    res.status(201).json({ workspace });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
