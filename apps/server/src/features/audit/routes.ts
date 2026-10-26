/**
 * 统一审计中心 API（Agent Server 侧）。
 *
 * 边界说明（重要）：
 * - 本路由只聚合 **Agent Server 自己拥有的数据**：IM 会话审计、问数审计、用量事件。
 * - **MCP 平台审计不在这里**——它由 Control Plane 进程（`/mcp-api`）持有，
 *   Agent Server 读不到也不伪造。需要 MCP section 的前端应并行调用 Control Plane 后合并。
 *   overview 响应体里的 `note` 字段显式说明这一点。
 */

import { Router, type Request, type Response } from "express";
import { optionalString } from "@open-agent-tools/api-contracts/values";
import { listImChatAudits, getImChatAudit, type ImChatAuditFilters } from "../im/audit.js";
import { listQueryAudits } from "../query/audit/queryAudit.js";
import { listRecentUsage, summarizeUsage } from "../../platform/usage/events.js";
import { resolveWorkspace } from "../../platform/workspace/store.js";
import { logTrace } from "../../platform/trace.js";

export const auditRouter: Router = Router();

/** 时间窗口：from/to 统一为毫秒时间戳（含端点）。 */
interface TimeWindow {
  from?: number;
  to?: number;
}

function parseWindow(query: Record<string, unknown>): TimeWindow {
  const from = Number(query.from);
  const to = Number(query.to);
  return {
    ...(Number.isFinite(from) ? { from } : {}),
    ...(Number.isFinite(to) ? { to } : {}),
  };
}

function parseLimit(value: unknown, fallback = 20): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(200, Math.floor(parsed)));
}

function parseOffset(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

function isoOrUndefined(timestamp: number | undefined): string | undefined {
  return timestamp === undefined ? undefined : new Date(timestamp).toISOString();
}

/** IM 审计列表：支持工作区/平台/渠道/用户/会话类型/状态/时间窗/关键词与分页。 */
auditRouter.get("/api/admin/audit/im/audits", (req: Request, res: Response) => {
  const workspace = resolveWorkspace(req);
  if (!workspace.ok) {
    res.status(400).json({ error: `workspace not found: ${workspace.requested}` });
    return;
  }
  const { from, to } = parseWindow(req.query as Record<string, unknown>);
  const filters: ImChatAuditFilters = {
    workspace: workspace.workspaceId,
    ...(optionalString(req.query.platform) ? { platform: String(req.query.platform) } : {}),
    ...(optionalString(req.query.channelId) ? { channelId: String(req.query.channelId) } : {}),
    ...(optionalString(req.query.actor) ? { actor: String(req.query.actor) } : {}),
    ...(optionalString(req.query.chatType) ? { chatType: String(req.query.chatType) } : {}),
    ...(optionalString(req.query.status) ? { status: String(req.query.status) } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(optionalString(req.query.keyword) ? { keyword: String(req.query.keyword) } : {}),
    limit: parseLimit(req.query.limit),
    offset: parseOffset(req.query.offset),
  };
  const result = listImChatAudits(filters);
  res.json(result);
});

/** 单条 IM 审计详情。 */
auditRouter.get("/api/admin/audit/im/audits/:id", (req: Request, res: Response) => {
  const workspace = resolveWorkspace(req);
  if (!workspace.ok) {
    res.status(400).json({ error: `workspace not found: ${workspace.requested}` });
    return;
  }
  const audit = getImChatAudit(req.params.id as string);
  if (!audit || audit.workspace !== workspace.workspaceId) {
    res.status(404).json({ error: "im chat audit not found" });
    return;
  }
  res.json({ audit });
});

/**
 * 统一审计中心概览：按 section 返回各来源的审计摘要。
 *
 * section 形状统一为 `{ key, title, total, items }`，便于前端统一渲染。
 * `mcp` section **不在这里**：MCP 平台审计由 Control Plane（/mcp-api）持有，
 * 前端需并行调用后合并（见响应体 note 字段）。
 */
auditRouter.get("/api/admin/audit/overview", (req: Request, res: Response) => {
  const workspace = resolveWorkspace(req);
  if (!workspace.ok) {
    res.status(400).json({ error: `workspace not found: ${workspace.requested}` });
    return;
  }
  const workspaceId = workspace.workspaceId;
  const { from, to } = parseWindow(req.query as Record<string, unknown>);
  const limit = parseLimit(req.query.limit);

  const imResult = listImChatAudits({
    workspace: workspaceId,
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    limit,
  });

  // 问数审计的时间窗是 ISO 字符串（既有表结构如此），这里做一次转换。
  const queryResult = listQueryAudits({
    workspace: workspaceId,
    ...(isoOrUndefined(from) ? { from: isoOrUndefined(from)! } : {}),
    ...(isoOrUndefined(to) ? { to: isoOrUndefined(to)! } : {}),
    limit,
  });

  const usageEvents = listRecentUsage(limit, workspaceId).filter((event) => {
    if (from !== undefined && event.createdAt < from) return false;
    if (to !== undefined && event.createdAt > to) return false;
    return true;
  });
  const usageSummary = summarizeUsage(from, to, workspaceId);

  const sections = [
    {
      key: "im",
      title: "IM 会话审计",
      total: imResult.total,
      items: imResult.items,
    },
    {
      key: "query",
      title: "问数审计",
      total: queryResult.total,
      items: queryResult.records,
    },
    {
      key: "usage",
      title: "用量事件",
      total: usageSummary.totals.events,
      items: usageEvents,
    },
  ];

  logTrace("audit.overview", {
    workspaceId,
    from: from ?? null,
    to: to ?? null,
    sections: sections.map((section) => ({ key: section.key, total: section.total })),
  });

  res.json({
    sections,
    note: "MCP 平台审计由 Control Plane（/mcp-api）持有，不在本服务范围内；需要该 section 的前端应并行调用 Control Plane 后合并。",
  });
});
