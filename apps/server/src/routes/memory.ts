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
  getFact,
  getMemoryStats,
  listFactHistory,
  listFactsPage,
  listRecentFacts,
  locateForgetTargets,
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

/** 事实列表：默认返回全部状态（含待审核），支持分页与关键词。 */
memoryRouter.get("/api/memory/facts", (req: Request, res: Response) => {
  const workspaceId = workspaceOf(req, res);
  if (!workspaceId) return;
  const scopeKind = req.query.scopeKind;
  const status = req.query.status;
  const page = listFactsPage({
    workspaceId,
    ...(scopeKind === "person" || scopeKind === "group"
      ? { scopeKind: scopeKind as MemoryScopeKind }
      : {}),
    ...(typeof req.query.scopeKey === "string" ? { scopeKey: req.query.scopeKey } : {}),
    ...(status === "active" || status === "superseded" || status === "all"
      ? { status }
      : { status: "all" }),
    includeUnreviewed: req.query.all === "1" || req.query.includeUnreviewed === "1",
    ...(typeof req.query.keyword === "string" ? { keyword: req.query.keyword } : {}),
    limit: Math.min(Number.parseInt(String(req.query.limit ?? "50"), 10) || 50, 200),
    offset: Math.max(0, Number.parseInt(String(req.query.offset ?? "0"), 10) || 0),
  });
  res.json(page);
});

/** 单条详情：事实本体 + 版本链（同 scope/subject/slug 的全部历史版本）。 */
memoryRouter.get("/api/memory/facts/:id", (req: Request, res: Response) => {
  const workspaceId = workspaceOf(req, res);
  if (!workspaceId) return;
  const factId = typeof req.params.id === "string" ? req.params.id : "";
  const fact = factId ? getFact(factId) : null;
  if (!fact || fact.workspaceId !== workspaceId) {
    res.status(404).json({ error: "memory fact not found" });
    return;
  }
  res.json({ fact, history: listFactHistory(fact) });
});

/**
 * 批量审核：逐条独立处理，返回成功/失败明细。
 * 不做整体回滚——部分成功比全失败更可用，调用方按结果展示。
 */
memoryRouter.post("/api/memory/facts/review", (req: Request, res: Response) => {
  const workspaceId = workspaceOf(req, res);
  if (!workspaceId) return;
  const body = req.body as { ids?: unknown; accepted?: unknown } | undefined;
  const ids = Array.isArray(body?.ids)
    ? body.ids.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  if (ids.length === 0 || typeof body?.accepted !== "boolean") {
    res.status(400).json({ error: "ids must be a non-empty array and accepted a boolean" });
    return;
  }
  if (ids.length > 200) {
    res.status(400).json({ error: "at most 200 ids per request" });
    return;
  }
  const succeeded: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const id of ids) {
    try {
      const fact = getFact(id);
      if (!fact || fact.workspaceId !== workspaceId) throw new Error("not found in workspace");
      setFactReview(id, body.accepted);
      succeeded.push(id);
    } catch (error) {
      failed.push({ id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  logTrace("memory.review_batch", { accepted: body.accepted, ok: succeeded.length, failed: failed.length });
  res.json({ ok: true, succeeded, failed });
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

/** 总览统计：计数、按类型/作用域分布、近期变更。 */
memoryRouter.get("/api/memory/stats", (req: Request, res: Response) => {
  const workspaceId = workspaceOf(req, res);
  if (!workspaceId) return;
  res.json({
    stats: getMemoryStats(workspaceId),
    recent: listRecentFacts(workspaceId, 20),
  });
});

/**
 * 遗忘预览：与实际删除共用 `locateForgetTargets`，保证数字一致。
 * 明确回传“不受影响”的范围，避免用户误以为连聊天记录一起删了。
 */
memoryRouter.get("/api/memory/forget/preview", (req: Request, res: Response) => {
  const workspaceId = workspaceOf(req, res);
  if (!workspaceId) return;
  const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
  const personId = typeof req.query.personId === "string" ? req.query.personId : undefined;
  if (!sessionId && !personId) {
    res.status(400).json({ error: "sessionId or personId is required" });
    return;
  }
  const targets = locateForgetTargets({
    workspaceId,
    ...(sessionId ? { sessionId } : {}),
    ...(personId ? { personId } : {}),
  });
  res.json({
    facts: targets.factIds.length,
    summaries: targets.summaries,
    lineage: targets.lineage,
    /** 这些数据不在遗忘范围内，必须让用户看到。 */
    untouched: ["会话原文（messages）", "IM 审计记录", "账号目录"],
  });
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
