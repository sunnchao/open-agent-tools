import { Router, type Request, type Response } from "express";
import {
  createChannel,
  deleteChannel,
  getChannel,
  isImPlatform,
  listChannels,
  updateChannel,
  type ImChannelInput,
} from "../im/channels/store.js";
import { restartChannel, syncImChannels, getChannelStatuses } from "../im/channels/index.js";
import { getImStatus } from "../im/index.js";
import { archiveImChannelAccounts } from "../im/accounts/store.js";
import { resolveWorkspace } from "../workspace.js";

export const imChannelsRouter: Router = Router();

/** 解析请求体为渠道字段；未提供的字段不携带（PUT 时留空=保留原值）。 */
function channelPayload(body: unknown): Partial<Omit<ImChannelInput, "id">> {
  const value = body as Record<string, unknown> | undefined;
  return {
    ...(typeof value?.name === "string" ? { name: value.name } : {}),
    ...(isImPlatform(value?.platform) ? { platform: value.platform } : {}),
    ...(typeof value?.appId === "string" ? { appId: value.appId } : {}),
    ...(typeof value?.appSecret === "string" ? { appSecret: value.appSecret } : {}),
    ...(typeof value?.encryptKey === "string" ? { encryptKey: value.encryptKey } : {}),
    ...(Array.isArray(value?.ragSources)
      ? { ragSources: value.ragSources.filter((item): item is string => typeof item === "string") }
      : {}),
    ...(Array.isArray(value?.sqlSources)
      ? { sqlSources: value.sqlSources.filter((item): item is string => typeof item === "string") }
      : {}),
    ...(Array.isArray(value?.mcpTools)
      ? {
          mcpTools: value.mcpTools
            .filter(
              (item): item is { serviceSlug: string; toolName: string } =>
                typeof item === "object" &&
                item !== null &&
                typeof (item as { serviceSlug?: unknown }).serviceSlug === "string" &&
                typeof (item as { toolName?: unknown }).toolName === "string",
            )
            .map((item) => ({ serviceSlug: item.serviceSlug, toolName: item.toolName })),
        }
      : {}),
    ...(typeof value?.ragTopK === "number" ? { ragTopK: value.ragTopK } : {}),
    ...(typeof value?.requireMention === "boolean" ? { requireMention: value.requireMention } : {}),
    ...(typeof value?.enabled === "boolean" ? { enabled: value.enabled } : {}),
    ...(typeof value?.workspaceId === "string" ? { workspaceId: value.workspaceId } : {}),
  };
}

/** 公开列表：只返回启用渠道，供聊天/设置下拉使用（不含任何密钥）。 */
imChannelsRouter.get("/api/im/channels", (req: Request, res: Response) => {
  const workspace = resolveWorkspace(req);
  if (!workspace.ok) {
    res.status(400).json({ error: `workspace not found: ${workspace.requested}` });
    return;
  }
  res.json({
    channels: listChannels().filter((channel) => channel.workspaceId === workspace.workspaceId),
  });
});

/** 管理列表：含停用渠道与运行连接状态（密钥仅掩码）。 */
imChannelsRouter.get("/api/admin/im/channels", (req: Request, res: Response) => {
  const workspace = resolveWorkspace(req);
  if (!workspace.ok) {
    res.status(400).json({ error: `workspace not found: ${workspace.requested}` });
    return;
  }
  res.json({
    channels: getChannelStatuses(workspace.workspaceId),
  });
});

imChannelsRouter.post("/api/admin/im/channels", async (req: Request, res: Response) => {
  try {
    const workspace = resolveWorkspace(req);
    if (!workspace.ok) {
      res.status(400).json({ error: `workspace not found: ${workspace.requested}` });
      return;
    }
    // 必填字段缺失由 createChannel 内部校验（name/appId/platform 非法即 400）。
    const channel = createChannel({
      ...channelPayload(req.body),
      workspaceId: workspace.workspaceId,
    } as ImChannelInput);
    await restartChannel(channel.id);
    res.status(201).json({ channel });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

imChannelsRouter.put("/api/admin/im/channels/:id", async (req: Request, res: Response) => {
  try {
    const workspace = resolveWorkspace(req);
    if (!workspace.ok) {
      res.status(400).json({ error: `workspace not found: ${workspace.requested}` });
      return;
    }
    const id = req.params.id as string;
    const existing = getChannel(id, { includeDisabled: true });
    if (!existing || existing.workspaceId !== workspace.workspaceId) {
      res.status(404).json({ error: "IM channel not found" });
      return;
    }
    const channel = updateChannel(id, {
      ...channelPayload(req.body),
      workspaceId: workspace.workspaceId,
    });
    if (!channel) {
      res.status(404).json({ error: "IM channel not found" });
      return;
    }
    await restartChannel(channel.id);
    res.json({ channel });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

imChannelsRouter.delete("/api/admin/im/channels/:id", async (req: Request, res: Response) => {
  const workspace = resolveWorkspace(req);
  if (!workspace.ok) {
    res.status(400).json({ error: `workspace not found: ${workspace.requested}` });
    return;
  }
  const id = req.params.id as string;
  const channel = getChannel(id, { includeDisabled: true });
  if (!channel || channel.workspaceId !== workspace.workspaceId) {
    res.status(404).json({ error: "IM channel not found" });
    return;
  }
  archiveImChannelAccounts(id, {
    name: channel.name,
    platform: channel.platform,
    workspaceId: channel.workspaceId,
  });
  if (!deleteChannel(id)) {
    res.status(404).json({ error: "IM channel not found" });
    return;
  }
  await syncImChannels();
  res.status(204).end();
});

/** 手动重启渠道（修改开放平台配置后，无需重写凭据）。 */
imChannelsRouter.post("/api/admin/im/channels/:id/restart", async (req: Request, res: Response) => {
  const workspace = resolveWorkspace(req);
  if (!workspace.ok) {
    res.status(400).json({ error: `workspace not found: ${workspace.requested}` });
    return;
  }
  const id = req.params.id as string;
  const channel = getChannel(id, { includeDisabled: true });
  if (!channel || channel.workspaceId !== workspace.workspaceId) {
    res.status(404).json({ error: "IM channel not found" });
    return;
  }
  await restartChannel(id);
  res.json(getImStatus(workspace.workspaceId));
});
