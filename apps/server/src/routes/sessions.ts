import { Router, type Request, type Response } from "express";
import {
  createSession,
  deleteMessage,
  deleteSession,
  getSession,
  listSessionsWithMessages,
  renameSession,
  type SessionSourceFilter,
} from "../db.js";
import { logTrace } from "../trace.js";
import { resolveWorkspace } from "../workspace.js";

export const sessionsRouter: ReturnType<typeof Router> = Router();

/** 解析 source 查询参数；缺省只看 Web 会话（IM 会话不污染 Web 侧边栏）。 */
function parseSourceFilter(value: unknown): SessionSourceFilter {
  if (value === "im" || value === "all" || value === "web") return value;
  return "web";
}

sessionsRouter.get("/api/sessions", (req: Request, res: Response) => {
  const workspace = resolveWorkspace(req);
  if (!workspace.ok) {
    res.status(400).json({ error: `workspace not found: ${workspace.requested}` });
    return;
  }
  const source = parseSourceFilter(req.query.source);
  const sessions = listSessionsWithMessages(workspace.workspaceId, { source });
  logTrace("sessions.list", {
    workspaceId: workspace.workspaceId,
    source,
    count: sessions.length,
  });
  res.json({ sessions });
});

sessionsRouter.post("/api/sessions", (req: Request, res: Response) => {
  const workspace = resolveWorkspace(req);
  if (!workspace.ok) {
    res.status(400).json({ error: `workspace not found: ${workspace.requested}` });
    return;
  }
  const body = req.body as { id?: string; title?: string } | undefined;
  const session = createSession({
    id: typeof body?.id === "string" ? body.id : undefined,
    title: typeof body?.title === "string" ? body.title : undefined,
    workspaceId: workspace.workspaceId,
  });
  logTrace("session.created", { sessionId: session.id, workspaceId: workspace.workspaceId });
  res.status(201).json({ session });
});

sessionsRouter.get("/api/sessions/:id", (req: Request, res: Response) => {
  const session = getSession(req.params.id as string);
  if (!session) {
    logTrace("session.not_found", { sessionId: req.params.id }, "warn");
    res.status(404).json({ error: "session not found" });
    return;
  }
  logTrace("session.loaded", { sessionId: session.id, messages: session.messages.length });
  res.json({ session });
});

sessionsRouter.patch("/api/sessions/:id", (req: Request, res: Response) => {
  const { title } = req.body as { title?: string };
  if (typeof title !== "string" || !title.trim()) {
    logTrace("session.rename_rejected", { reason: "title is required" }, "warn");
    res.status(400).json({ error: "title is required" });
    return;
  }
  const session = renameSession(req.params.id as string, title.trim());
  if (!session) {
    logTrace("session.not_found", { sessionId: req.params.id }, "warn");
    res.status(404).json({ error: "session not found" });
    return;
  }
  logTrace("session.renamed", { sessionId: session.id });
  res.json({ session });
});

sessionsRouter.delete("/api/sessions/:id", (req: Request, res: Response) => {
  const ok = deleteSession(req.params.id as string);
  if (!ok) {
    logTrace("session.not_found", { sessionId: req.params.id }, "warn");
    res.status(404).json({ error: "session not found" });
    return;
  }
  logTrace("session.deleted", { sessionId: req.params.id });
  res.status(204).end();
});

sessionsRouter.delete("/api/messages/:id", (req: Request, res: Response) => {
  const ok = deleteMessage(req.params.id as string);
  if (!ok) {
    logTrace("message.not_found", { messageId: req.params.id }, "warn");
    res.status(404).json({ error: "message not found" });
    return;
  }
  logTrace("message.deleted", { messageId: req.params.id });
  res.status(204).end();
});
