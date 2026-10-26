/**
 * 记忆管理 API（最小面）：审核、列表、遗忘。
 *
 * 与 chat 同进程、同 workspace 归属；不做身份隔离（与现有 session API 一致，
 * README 已记录该局限）。写操作都带 workspaceId，避免跨空间误删。
 */
import { Router, type Request, type Response } from "express";
import { resolveWorkspace } from "../workspace.js";
import {
  forgetMemory,
  listFacts,
  setFactReview,
  type MemoryScopeKind,
} from "../memory/store.js";
import { logTrace } from "../trace.js";

export const memoryRouter: ReturnType<typeof Router> = Router();

function workspaceOf(req: Request, res: Response): string | null {
  const workspace = resolveWorkspace(req);
  if (!workspace.ok) {
    res.status(400).json({ error: `workspace not found: ${workspace.requested}` });
    return null;
  }
  return workspace.workspaceId;
}

/** 待审核队列：默认只看 unreviewed，`?all=1` 返回全部。 */
memoryRouter.get("/api/memory/facts", (req: Request, res: Response) => {
  const workspaceId = workspaceOf(req, res);
  if (!workspaceId) return;
  const scopeKind = req.query.scopeKind;
  const status = req.query.status;
  const facts = listFacts({
    workspaceId,
    ...(scopeKind === "person" || scopeKind === "group"
      ? { scopeKind: scopeKind as MemoryScopeKind }
      : {}),
    ...(typeof req.query.scopeKey === "string" ? { scopeKey: req.query.scopeKey } : {}),
    ...(status === "active" || status === "superseded" || status === "all"
      ? { status }
      : { status: "all" }),
    includeUnreviewed: req.query.all === "1" || req.query.includeUnreviewed === "1",
    limit: Math.min(Number.parseInt(String(req.query.limit ?? "100"), 10) || 100, 500),
  });
  res.json({ facts });
});

/** 接受 / 拒绝一条提议：拒绝即物理删除（提议没有历史价值）。 */
memoryRouter.post("/api/memory/facts/:id/review", (req: Request, res: Response) => {
  const workspaceId = workspaceOf(req, res);
  if (!workspaceId) return;
  const accepted = (req.body as { accepted?: unknown } | undefined)?.accepted;
  if (typeof accepted !== "boolean") {
    res.status(400).json({ error: "accepted must be a boolean" });
    return;
  }
  const factId = typeof req.params.id === "string" ? req.params.id : "";
  if (!factId) {
    res.status(400).json({ error: "id is required" });
    return;
  }
  const fact = setFactReview(factId, accepted);
  logTrace("memory.review", { id: factId, accepted });
  res.json({ ok: true, fact });
});

/**
 * 遗忘：`?sessionId=` 或 `?personId=`，至少一个。
 * 只清记忆派生数据；会话原文与 IM 审计由各自的删除/保留策略负责。
 */
memoryRouter.delete("/api/memory/facts", (req: Request, res: Response) => {
  const workspaceId = workspaceOf(req, res);
  if (!workspaceId) return;
  const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
  const personId = typeof req.query.personId === "string" ? req.query.personId : undefined;
  if (!sessionId && !personId) {
    res.status(400).json({ error: "sessionId or personId is required" });
    return;
  }
  const result = forgetMemory({
    workspaceId,
    ...(sessionId ? { sessionId } : {}),
    ...(personId ? { personId } : {}),
    reason: "api",
  });
  logTrace("memory.forget", { sessionId: sessionId ?? null, personId: personId ?? null, ...result });
  res.json({ ok: true, ...result });
});
