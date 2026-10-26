import { Router, type Request, type Response } from "express";
import { appAccessToken } from "./access.js";
import {
  createPublishedApp,
  deletePublishedApp,
  getPublishedApp,
  getPublishedAppBySlug,
  listPublishedApps,
  rotateAccessToken,
  updatePublishedApp,
  verifyAppAccess,
  type PublishedAppInput,
} from "./published.js";
import { tokensUsedToday } from "./quota.js";
import { logTrace } from "../../platform/trace.js";
import { resolveWorkspace } from "../../platform/workspace/store.js";
import { gatewayConnectionDetails } from "../../platform/auth/viewer.js";

export const publishedAppsRouter: ReturnType<typeof Router> = Router();

function parseSuggestions(value: unknown): PublishedAppInput["suggestions"] {
  if (!Array.isArray(value)) return undefined;
  const parsed = value
    .filter(
      (item): item is { title?: unknown; prompt?: unknown } =>
        Boolean(item) && typeof item === "object",
    )
    .map((item) => ({
      title: typeof item.title === "string" ? item.title.slice(0, 60) : "",
      prompt: typeof item.prompt === "string" ? item.prompt.slice(0, 500) : "",
    }))
    .filter((item) => item.title && item.prompt)
    .slice(0, 8);
  return parsed;
}

function parseInput(body: unknown, requireName: boolean): Partial<PublishedAppInput> {
  const value = body as Record<string, unknown> | undefined;
  const input: Partial<PublishedAppInput> = {};
  if (typeof value?.name === "string" && (value.name.trim() || requireName)) {
    input.name = value.name;
  }
  if (typeof value?.slug === "string") input.slug = value.slug;
  if (typeof value?.description === "string") input.description = value.description;
  if (typeof value?.welcome === "string") input.welcome = value.welcome;
  const suggestions = parseSuggestions(value?.suggestions);
  if (suggestions) input.suggestions = suggestions;
  if (value?.resources && typeof value.resources === "object") {
    input.resources = value.resources as PublishedAppInput["resources"];
  }
  if (Array.isArray(value?.allowedGroups)) {
    input.allowedGroups = value.allowedGroups as string[];
  }
  if (value?.providerId === null || typeof value?.providerId === "string") {
    input.providerId = value.providerId as string | null;
  }
  if (value?.model === null || typeof value?.model === "string") {
    input.model = value.model as string | null;
  }
  if (value?.status === "ACTIVE" || value?.status === "ARCHIVED") {
    input.status = value.status;
  }
  if (value?.accessMode === "public" || value?.accessMode === "token") {
    input.accessMode = value.accessMode;
  }
  if (value?.rateLimitPerMinute !== undefined) {
    input.rateLimitPerMinute = Number(value.rateLimitPerMinute);
  }
  if (value?.dailyTokenBudget !== undefined) {
    input.dailyTokenBudget = Number(value.dailyTokenBudget);
  }
  return input;
}

/* ---------------- 管理侧（Studio，受部署 token 保护） ---------------- */

publishedAppsRouter.get("/api/admin/published-apps", (req: Request, res: Response) => {
  const workspace = resolveWorkspace(req);
  if (!workspace.ok) {
    res.status(400).json({ error: `workspace not found: ${workspace.requested}` });
    return;
  }
  const apps = listPublishedApps(workspace.workspaceId);
  res.json({ apps });
});

/** 管理侧只读的网关接入说明：不返回 HMAC 密钥，也不允许浏览器生成断言。 */
publishedAppsRouter.get("/api/admin/published-apps/identity", (_req: Request, res: Response) => {
  res.json({ identity: gatewayConnectionDetails() });
});

publishedAppsRouter.post("/api/admin/published-apps", (req: Request, res: Response) => {
  const workspace = resolveWorkspace(req);
  if (!workspace.ok) {
    res.status(400).json({ error: `workspace not found: ${workspace.requested}` });
    return;
  }
  const input = parseInput(req.body, true);
  if (!input.name?.trim()) {
    res.status(400).json({ error: "app name is required" });
    return;
  }
  try {
    const app = createPublishedApp(workspace.workspaceId, {
      ...input,
      name: input.name,
    } as PublishedAppInput);
    logTrace("published_app.created", {
      workspaceId: workspace.workspaceId,
      appId: app.id,
      slug: app.slug,
    });
    res.status(201).json({ app });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

publishedAppsRouter.put("/api/admin/published-apps/:id", (req: Request, res: Response) => {
  const workspace = resolveWorkspace(req);
  if (!workspace.ok) {
    res.status(400).json({ error: `workspace not found: ${workspace.requested}` });
    return;
  }
  const existing = getPublishedApp(String(req.params.id));
  // 归属校验：不能通过改 id 操作别的空间的发布应用。
  if (!existing || existing.workspaceId !== workspace.workspaceId) {
    res.status(404).json({ error: "published app not found" });
    return;
  }
  try {
    const app = updatePublishedApp(existing.id, parseInput(req.body, false));
    res.json({ app });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

publishedAppsRouter.delete("/api/admin/published-apps/:id", (req: Request, res: Response) => {
  const workspace = resolveWorkspace(req);
  if (!workspace.ok) {
    res.status(400).json({ error: `workspace not found: ${workspace.requested}` });
    return;
  }
  const existing = getPublishedApp(String(req.params.id));
  if (!existing || existing.workspaceId !== workspace.workspaceId) {
    res.status(404).json({ error: "published app not found" });
    return;
  }
  deletePublishedApp(existing.id);
  logTrace("published_app.deleted", { appId: existing.id, slug: existing.slug });
  res.status(204).end();
});

/* ---------------- 访问口令轮换 ---------------- */

/**
 * 生成/撤销访问口令。
 *
 * 明文口令**只在这一次响应里返回**，库里只存 sha256——之后无法再取回，只能轮换。
 * `enable=false` 撤销口令并回到 public 模式。
 */
publishedAppsRouter.post(
  "/api/admin/published-apps/:id/access-token",
  (req: Request, res: Response) => {
    const workspace = resolveWorkspace(req);
    if (!workspace.ok) {
      res.status(400).json({ error: `workspace not found: ${workspace.requested}` });
      return;
    }
    const existing = getPublishedApp(String(req.params.id));
    if (!existing || existing.workspaceId !== workspace.workspaceId) {
      res.status(404).json({ error: "published app not found" });
      return;
    }
    const enable = (req.body as { enable?: unknown } | undefined)?.enable !== false;
    const token = rotateAccessToken(existing.id, enable);
    logTrace("published_app.access_token", {
      appId: existing.id,
      slug: existing.slug,
      mode: enable ? "token" : "public",
    });
    res.json({
      app: getPublishedApp(existing.id),
      // 仅此一次返回明文；撤销时返回 null。
      token,
    });
  },
);

/* ---------------- 终端用户侧（员工入口，公开可读） ---------------- */

/**
 * 按 slug 返回应用外观与绑定能力。
 *
 * 只暴露「员工需要知道的」：名称、欢迎语、示例问题、可用资源数量。
 * 不返回 provider 配置、密钥、workspace 内部 id，也不返回内部可见分组名。
 */
publishedAppsRouter.get("/api/apps/:slug", (req: Request, res: Response) => {
  const app = getPublishedAppBySlug(String(req.params.slug));
  if (!app || app.status !== "ACTIVE") {
    res.status(404).json({ error: "app not found" });
    return;
  }
  // 口令模式：资料页同样要求口令，否则「谁能看到这个应用叫什么」也成了信息泄露。
  const token = appAccessToken(req);
  if (!verifyAppAccess(app, token)) {
    res.status(401).json({ error: "需要访问口令，请使用管理员提供的完整链接" });
    return;
  }
  res.json({
    app: {
      slug: app.slug,
      name: app.name,
      description: app.description,
      welcome: app.welcome,
      suggestions: app.suggestions,
      capabilities: {
        ragSources: app.resources.rag?.sources?.length ?? 0,
        mcpTools: app.resources.mcpTools?.length ?? 0,
        sqlSources: app.resources.sqlSources?.length ?? 0,
      },
      quota: {
        rateLimitPerMinute: app.rateLimitPerMinute,
        dailyTokenBudget: app.dailyTokenBudget,
        usedTokensToday: app.dailyTokenBudget > 0 ? tokensUsedToday(app) : 0,
      },
    },
  });
});
