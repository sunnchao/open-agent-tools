import { Router, type Request, type Response } from "express";
import { parseExportFormat, sendExport } from "../export/respond.js";
import { listUsageExportRows, USAGE_EXPORT_COLUMNS, type UsageExportKind } from "./export.js";
import { logTrace } from "../trace.js";
import { listRecentUsage, summarizeUsage } from "./events.js";
import { resolveWorkspace } from "../workspace/store.js";
import { syncRagUsage } from "./ragSync.js";

export const usageRouter: ReturnType<typeof Router> = Router();

const DAY_MS = 24 * 60 * 60 * 1000;

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * 用量汇总：计费、扩容与续费谈判的证据来源。
 * 支持 `from`/`to`（ISO 时间）或 `days`（最近 N 天，默认 30，上限 365）。
 */
usageRouter.get("/api/admin/usage", async (req: Request, res: Response) => {
  const workspace = resolveWorkspace(req);
  if (!workspace.ok) {
    res.status(400).json({ error: `workspace not found: ${workspace.requested}` });
    return;
  }
  const days = Number(req.query.days);
  const to = parseTimestamp(req.query.to) ?? Date.now();
  const from =
    parseTimestamp(req.query.from) ??
    to - Math.max(1, Math.min(365, Number.isFinite(days) ? Math.floor(days) : 30)) * DAY_MS;
  if (from > to) {
    res.status(400).json({ error: "from must not be later than to" });
    return;
  }
  // 支持显式 `workspaceId=*` 查看全局，避免多空间时看不到合计。
  const scopeAll = req.query.workspaceId === "*";
  await syncRagUsage();
  const summary = summarizeUsage(from, to, scopeAll ? undefined : workspace.workspaceId);
  logTrace("usage.summary", {
    workspaceId: scopeAll ? "*" : workspace.workspaceId,
    from,
    to,
    events: summary.totals.events,
    totalTokens: summary.totals.totalTokens,
  });
  res.json({ usage: { ...summary, workspaceId: scopeAll ? "*" : workspace.workspaceId } });
});

/** 最近用量事件（对账抽查与排障）。 */
usageRouter.get("/api/admin/usage/events", async (req: Request, res: Response) => {
  const workspace = resolveWorkspace(req);
  if (!workspace.ok) {
    res.status(400).json({ error: `workspace not found: ${workspace.requested}` });
    return;
  }
  const limit = Number(req.query.limit);
  const scopeAll = req.query.workspaceId === "*";
  await syncRagUsage();
  const events = listRecentUsage(
    Number.isFinite(limit) ? limit : 50,
    scopeAll ? undefined : workspace.workspaceId,
  );
  res.json({ events });
});

/**
 * 用量明细导出(等保/内审与账单核对)。
 *
 * 时间窗口径与 `/api/admin/usage` 一致(`from`/`to` 或 `days`,默认 30 天);
 * `workspaceId=*` 导出全局;`kind=chat|tool` 可只导某一类事件。
 * 结果有条数硬上限,超限截断并通过 `x-export-truncated` 明示。
 */
usageRouter.get("/api/admin/usage/export", async (req: Request, res: Response) => {
  const format = parseExportFormat(req.query.format);
  if (!format) {
    res.status(400).json({ error: "format 必须为 csv 或 json" });
    return;
  }
  const kindParam = typeof req.query.kind === "string" ? req.query.kind.trim() : "";
  if (kindParam && kindParam !== "chat" && kindParam !== "tool") {
    res.status(400).json({ error: "kind 必须为 chat 或 tool" });
    return;
  }
  const kind: UsageExportKind | undefined =
    kindParam === "chat" || kindParam === "tool" ? kindParam : undefined;
  const workspace = resolveWorkspace(req);
  if (!workspace.ok) {
    res.status(400).json({ error: `workspace not found: ${workspace.requested}` });
    return;
  }
  const days = Number(req.query.days);
  const to = parseTimestamp(req.query.to) ?? Date.now();
  const from =
    parseTimestamp(req.query.from) ??
    to - Math.max(1, Math.min(365, Number.isFinite(days) ? Math.floor(days) : 30)) * DAY_MS;
  if (from > to) {
    res.status(400).json({ error: "from must not be later than to" });
    return;
  }
  // 与汇总/事件接口一致:显式 `workspaceId=*` 导出全局,否则按当前空间归集。
  const scopeAll = req.query.workspaceId === "*";
  await syncRagUsage();
  const { rows, truncated } = listUsageExportRows({
    from,
    to,
    ...(kind ? { kind } : {}),
    ...(scopeAll ? {} : { workspaceId: workspace.workspaceId }),
  });
  logTrace("usage.export", {
    workspaceId: scopeAll ? "*" : workspace.workspaceId,
    format,
    kind: kind ?? "all",
    rows: rows.length,
    truncated,
  });
  sendExport(res, {
    format,
    columns: USAGE_EXPORT_COLUMNS,
    rows,
    filenameBase: "usage-events",
    truncated,
  });
});
