import { Router } from "express";
import { getImStatus } from "../index.js";
import { resolveWorkspace } from "../../../platform/workspace/store.js";

export const imRouter: Router = Router();

/** 诊断接口：机器人是否启用/连接、绑定的知识库 source。 */
imRouter.get("/api/im/status", (req, res) => {
  const workspace = resolveWorkspace(req);
  if (!workspace.ok) {
    res.status(400).json({ error: `workspace not found: ${workspace.requested}` });
    return;
  }
  res.json(getImStatus(workspace.workspaceId));
});
