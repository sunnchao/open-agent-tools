import { Router, type Request, type Response } from "express";
import { addMessage, ensureSession, updateMessage, type Role } from "../db.js";
import { getPublishedAppBySlug, verifyAppAccess, type PublishedApp } from "../publishedApps.js";
import { checkAppQuota } from "../appQuota.js";
import type { SqlQuestionSource } from "../function_tools/sqlQuestion.js";
import { listSchemaSources } from "../schemaSources/store.js";
import { getDefaultProvider, getProvider } from "../providers/store.js";
import { createLlmClient } from "../providers/clients/index.js";
import { normalizeResourceBindings } from "../resources.js";
import { recordUsageEvent } from "../usage.js";
import { logDebugDuration, logTrace, truncate } from "../trace.js";
import { runTraced, withTraceAttributes } from "@open-agent-tools/observability";
import { ChatTurnError, streamChatTurn, usageSnapshot, type ChatTurnUsage } from "./chatCore.js";
import {
  identityMode,
  viewerAssertionOptions,
  verifyViewerAssertion,
  type VerifiedViewer,
} from "../trustedIdentity.js";

export const appChatRouter: ReturnType<typeof Router> = Router();

interface AppChatBody {
  messages?: Array<{ role: Role; content: string }>;
  sessionId?: string;
  viewerGroups?: unknown;
}

/** 访问口令可走请求头或 query（分享链接形态），两者都支持便于嵌入与直接粘贴。 */
function appAccessToken(req: Request): string | null {
  const header = req.header("x-app-access-token")?.trim();
  if (header) return header;
  const query = req.query.access_token;
  return typeof query === "string" && query.trim() ? query.trim() : null;
}

/**
 * 终端用户对话入口（员工侧）。
 *
 * 与 `/api/chat` 的差别是**资源由发布配置决定**，请求体里不接受 resources / providerId / model：
 * 终端用户不应该能改知识库范围、加挂工具或换模型。这样发布态才是「产品」，而不是「给员工一个管理台」。
 */
appChatRouter.post("/api/apps/:slug/chat", async (req: Request, res: Response) => {
  const chatStartedAt = Date.now();
  const app = getPublishedAppBySlug(String(req.params.slug));
  if (!app || app.status !== "ACTIVE") {
    res.status(404).json({ error: "app not found" });
    return;
  }

  // 访问控制：token 模式下没有正确口令一律 401，且不泄露「应用存在但需要口令」之外的任何信息。
  if (!verifyAppAccess(app, appAccessToken(req))) {
    logTrace("app_chat.unauthorized", { slug: app.slug }, "warn");
    res.status(401).json({ error: "需要访问口令，请使用管理员提供的完整链接" });
    return;
  }

  // 身份断言必须先于配额与业务解析：伪造/过期/重放请求不能消耗正常应用额度。
  const body = (req.body ?? {}) as AppChatBody & Record<string, unknown>;
  if (body.viewerGroups !== undefined) {
    res.status(400).json({ error: "viewerGroups must come from a verified identity assertion" });
    return;
  }
  const mode = identityMode();
  const assertionHeader = req.header("x-viewer-assertion") ?? undefined;
  let viewer: VerifiedViewer | null = null;
  if (assertionHeader) {
    const options = viewerAssertionOptions();
    if (!options) {
      logTrace("app_chat.identity_not_configured", { slug: app.slug }, "error");
      res.status(503).json({ error: "该应用暂不可用：可信身份验证尚未配置" });
      return;
    }
    const verified = verifyViewerAssertion(assertionHeader, req, app.slug, options);
    if (!verified.ok) {
      logTrace("app_chat.identity_rejected", { slug: app.slug, reason: verified.reason }, "warn");
      res.status(401).json({ error: "身份断言无效，请通过公司统一登录进入" });
      return;
    }
    viewer = verified.viewer;
  } else if (
    mode === "required" ||
    (mode === "required_for_groups" && app.allowedGroups.length > 0)
  ) {
    res.status(401).json({ error: "请通过公司统一登录进入" });
    return;
  }
  const viewerGroups = (viewer?.groups ?? []).filter(
    (group) => group !== "*" && app.allowedGroups.includes(group),
  );

  // 配额：先拦，再进对话。拒绝时明确告知是限流还是预算，便于管理员判断是刷量还是该扩容。
  const quota = checkAppQuota(app);
  if (!quota.ok) {
    if (quota.reason === "rate_limited") {
      res
        .status(429)
        .set("retry-after", String(quota.retryAfterSeconds ?? 60))
        .json({ error: "请求过于频繁，请稍后再试", retryAfterSeconds: quota.retryAfterSeconds });
      return;
    }
    res.status(429).json({
      error: "该应用今日额度已用完，请联系管理员",
      usedTokensToday: quota.usedTokensToday,
      dailyTokenBudget: quota.dailyTokenBudget,
    });
    return;
  }

  const { messages, sessionId } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "messages must be a non-empty array" });
    return;
  }
  for (const message of messages) {
    if (!["user", "assistant", "system"].includes(message.role)) {
      res.status(400).json({ error: `invalid role: ${message.role}` });
      return;
    }
  }
  const provider = app.providerId
    ? getProvider(app.providerId, { requireEnabled: true })
    : getDefaultProvider({ requireEnabled: true });
  if (!provider) {
    res.status(503).json({ error: "该应用暂不可用：模型 Provider 未就绪" });
    return;
  }
  if (!provider.apiKey) {
    res.status(503).json({ error: "该应用暂不可用：Provider 未配置 API Key" });
    return;
  }

  const model = app.model || provider.models[0] || "gpt-4o-mini";
  // 发布配置可能已失效（数据源被删、知识库下线）：明确报 503，而不是抛成 500 让员工看到「服务器错误」。
  let bindings: ReturnType<typeof normalizeResourceBindings>;
  try {
    bindings = normalizeResourceBindings(app.resources);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logTrace(
      "app_chat.invalid_resources",
      { slug: app.slug, error: truncate(reason, 300) },
      "error",
    );
    res.status(503).json({ error: `该应用的资源配置已失效，请联系管理员（${reason}）` });
    return;
  }
  const workspaceId = app.workspaceId;
  const schemaSources: SqlQuestionSource[] =
    bindings.sqlSources.length > 0
      ? listSchemaSources()
          .filter((source) => bindings.sqlSources.includes(source.id))
          .map(({ id, name, connector }) => ({ id, name, connector }))
      : [];

  const llm = createLlmClient(provider);
  // 会话按「应用 + 已认证主体 + 前端会话 id」隔离；无身份时仍是公开匿名命名空间。
  const identityPart = viewer ? viewer.subjectHash : "anonymous";
  const resolvedSessionId = sessionId ? `${app.slug}:${identityPart}:${sessionId}` : null;
  let assistantMessageId: string | null = null;
  let toolRounds = 0;
  let turnUsage: ChatTurnUsage | null = null;

  logTrace("app_chat.start", {
    slug: app.slug,
    workspaceId,
    sessionId: resolvedSessionId,
    providerId: provider.id,
    model,
    ragSources: bindings.rag.sources.length,
    mcpToolBindings: bindings.mcpTools.length,
    sqlSources: bindings.sqlSources.join(",") || "(none)",
    identity: viewer ? "asserted" : "anonymous",
    subject: viewer?.subjectHash,
  });

  if (resolvedSessionId) {
    ensureSession(resolvedSessionId, workspaceId);
    const assistant = addMessage(resolvedSessionId, {
      role: "assistant",
      content: "",
      status: "streaming",
    });
    assistantMessageId = assistant?.id ?? null;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (data: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  if (assistantMessageId) send({ assistantMessageId });

  let fullContent = "";
  let outcome: "complete" | "error" = "complete";
  let errorMessage = "LLM request failed";

  try {
    const lastUserQuery = [...messages].reverse().find((m) => m.role === "user")?.content;
    await runTraced("app-chat-turn", async (span) => {
      span.update({ input: lastUserQuery ?? null, metadata: { slug: app.slug, model } });
      await withTraceAttributes(
        {
          sessionId: resolvedSessionId ?? undefined,
          tags: ["chat", "published-app", app.slug],
          metadata: { provider: provider.id, format: provider.format, model },
          version: "0.0.0",
        },
        async () => {
          const result = await streamChatTurn({
            llm,
            model,
            providerId: provider.id,
            workspaceId,
            messages,
            bindings,
            viewerGroups,
            resolvedSessionId,
            send,
            span,
            schemaSources,
          });
          fullContent = result.fullContent;
          toolRounds = result.toolRounds;
          turnUsage = result.usage;
        },
      );
      span.update({
        output: { content: fullContent },
        metadata: { slug: app.slug, model, toolRounds: String(toolRounds) },
      });
    });
  } catch (error) {
    outcome = "error";
    if (error instanceof ChatTurnError && error.partialContent) fullContent = error.partialContent;
    errorMessage = error instanceof Error ? error.message : "LLM request failed";
    logTrace(
      "app_chat.error",
      { slug: app.slug, sessionId: resolvedSessionId, error: truncate(errorMessage, 300) },
      "error",
    );
    send({ error: errorMessage });
  } finally {
    if (assistantMessageId) {
      updateMessage(assistantMessageId, {
        content: outcome === "error" ? fullContent || errorMessage : fullContent,
        status: outcome,
      });
    }
    const snapshot = turnUsage ? usageSnapshot(turnUsage) : null;
    if (snapshot) {
      recordUsageEvent({
        kind: "chat",
        workspaceId,
        sessionId: resolvedSessionId,
        providerId: provider.id,
        model,
        inputTokens: snapshot.inputTokens,
        outputTokens: snapshot.outputTokens,
        toolCalls: snapshot.toolCalls,
        durationMs: Date.now() - chatStartedAt,
        status: outcome === "error" ? "error" : "ok",
      });
    }
    logDebugDuration("app_chat.done", chatStartedAt, {
      slug: app.slug,
      toolRounds,
      status: outcome,
      totalTokens: snapshot?.totalTokens ?? 0,
    });
    send({ done: true, status: outcome, ...(snapshot ? { usage: snapshot } : {}) });
    res.end();
  }
});

/** 供测试与排障：读取发布应用（不经过 HTTP）。 */
export type { PublishedApp };
