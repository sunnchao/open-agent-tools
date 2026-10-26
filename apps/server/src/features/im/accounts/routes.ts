import { Router, type Request, type Response } from "express";
import {
  listImAccounts,
  updateImAccount,
  type ImAccountChannelState,
  type ImAccountUpdate,
} from "./store.js";
import { isImPlatform } from "../types.js";
import { resolveWorkspace } from "../../../platform/workspace/store.js";

export const imAccountsRouter: Router = Router();

const CHANNEL_STATES: ImAccountChannelState[] = ["all", "existing", "deleted"];

function queryString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function pageNumber(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(max, Math.floor(parsed)));
}

/** 账号目录：只读列表，账号由有效 IM 对话自动产生。 */
imAccountsRouter.get("/api/admin/im/accounts", (req: Request, res: Response) => {
  const workspace = resolveWorkspace(req);
  if (!workspace.ok) {
    res.status(400).json({ error: `workspace not found: ${workspace.requested}` });
    return;
  }

  const platform = queryString(req.query.platform);
  if (platform && !isImPlatform(platform)) {
    res.status(400).json({ error: `unsupported IM platform: ${platform}` });
    return;
  }
  const requestedState = queryString(req.query.channelState);
  const channelState = CHANNEL_STATES.includes(requestedState as ImAccountChannelState)
    ? (requestedState as ImAccountChannelState)
    : "all";
  const limit = Math.max(1, pageNumber(req.query.limit, 50, 200));
  const offset = pageNumber(req.query.offset, 0);

  const result = listImAccounts({
    workspaceId: workspace.workspaceId,
    ...(queryString(req.query.channelId) ? { channelId: queryString(req.query.channelId) } : {}),
    ...(platform ? { platform } : {}),
    ...(queryString(req.query.keyword) ? { keyword: queryString(req.query.keyword) } : {}),
    channelState,
    limit,
    offset,
  });
  res.json({ ...result, limit, offset });
});

/** 后台只允许编辑人工字段与模型绑定；账号新增/删除均由系统生命周期控制。 */
imAccountsRouter.patch("/api/admin/im/accounts/:id", (req: Request, res: Response) => {
  const workspace = resolveWorkspace(req);
  if (!workspace.ok) {
    res.status(400).json({ error: `workspace not found: ${workspace.requested}` });
    return;
  }
  const body = req.body as Record<string, unknown> | null | undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    res.status(400).json({ error: "request body must be an object" });
    return;
  }

  const input: ImAccountUpdate = {};
  const editableFields = ["displayName", "remark", "providerId", "model"] as const;
  for (const field of editableFields) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
    const value = body[field];
    if (value !== null && typeof value !== "string") {
      res.status(400).json({ error: `${field} must be a string or null` });
      return;
    }
    input[field] = value;
  }
  if (Object.keys(input).length === 0) {
    res.status(400).json({ error: "no editable account fields were provided" });
    return;
  }

  try {
    const account = updateImAccount(req.params.id as string, workspace.workspaceId, input);
    if (!account) {
      res.status(404).json({ error: "IM account not found" });
      return;
    }
    res.json({ account });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
