import {
  askChat,
  ChatRequestError,
  type ChatAnswer,
  type ChatProgressEvent,
} from "./chatClient.js";
import { recordImChatAudit, type ImChatAuditInput } from "./audit.js";
import {
  recordImAccountInteraction,
  resolveImAccountModel,
  updateImAccountExternalName,
  type ImAccountModelBinding,
} from "./accounts/store.js";
import { chunkText } from "./text.js";
import { buildImSessionId, type ImConfig, type ImMessageEvent } from "./types.js";
import { logDebugDuration, logTrace } from "../../platform/trace.js";

interface AnswerMessageDeps {
  reply: (text: string) => Promise<void>;
  askChat?: typeof askChat;
  resolveSenderName?: (actor: string) => Promise<string | null>;
  recordAudit?: typeof recordImChatAudit;
  recordAccountInteraction: typeof recordImAccountInteraction;
  updateAccountExternalName: typeof updateImAccountExternalName;
  resolveAccountModel: typeof resolveImAccountModel;
}

/**
 * IM 等待期状态提示的发送策略（钉钉/飞书共用）。
 *
 * 钉钉 sessionWebhook 与飞书回复接口都只能追加文本、不能编辑同一条消息，
 * 因此状态提示按“阶段追加、合并突发、封顶 3 条”发送，避免刷屏：
 * - 快链路（宽限期内答完）不发任何状态，保持单条答案；
 * - 慢链路先出一批待定状态，宽限期后按去重/防抖逐条追加，最终答案另起消息。
 */
const STATUS_GRACE_MS = 4000;
const STATUS_DEBOUNCE_MS = 350;
const MAX_STATUS_MESSAGES = 3;

/** 工具展示名可能含长别名：裁剪后拼进状态文案，避免超长刷屏。 */
function friendlyToolName(name: string): string {
  const text = name.trim() || "工具";
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/** Shared chat/reply/audit flow; platform adapters own event parsing and reply transport. */
export async function answerImMessage(
  config: ImConfig,
  event: ImMessageEvent,
  deps: AnswerMessageDeps,
): Promise<void> {
  if (event.text === null) return;
  const question = event.text;
  const startedAt = Date.now();
  const { platform, chatId, chatType, senderOpenId: actor } = event;
  const sessionId = buildImSessionId(platform, chatId, chatType, actor);
  if (actor && config.channelId) {
    try {
      deps.recordAccountInteraction({
        channelId: config.channelId,
        channelName: config.name,
        platform,
        workspaceId: config.workspaceId,
        externalUserId: actor,
        externalUserIdType: event.senderIdType,
        externalName: event.senderName,
        conversationId: chatId,
        chatType,
        occurredAt: startedAt,
      });
    } catch (error) {
      // Account bookkeeping is best-effort and must never block the answer.
      logTrace(`im.${platform}.account_record_error`, { error: String(error) }, "error");
    }
  }
  // Resolve directory names alongside chat; resolution failures leave the audit name empty.
  const actorNamePromise =
    actor && deps.resolveSenderName
      ? deps.resolveSenderName(actor).catch(() => null)
      : Promise.resolve(event.senderName);
  const resolvedActorNamePromise = actorNamePromise.then((name) => {
    if (actor && config.channelId && name) {
      try {
        deps.updateAccountExternalName(config.channelId, actor, name);
      } catch (error) {
        logTrace(`im.${platform}.account_name_error`, { error: String(error) }, "error");
      }
    }
    return name;
  });

  let accountModel: ImAccountModelBinding | null = null;
  if (actor && config.channelId) {
    try {
      accountModel = deps.resolveAccountModel(config.channelId, actor);
    } catch (error) {
      logTrace(`im.${platform}.account_model_error`, { error: String(error) }, "error");
    }
  }

  // 失败文案用的已完成步骤（如“检索知识库”“调用 SQL 问数 · xxx”）。
  const completedSteps: string[] = [];
  const pushStep = (step: string): void => {
    if (!completedSteps.includes(step)) completedSteps.push(step);
  };

  // 待发送的状态文案（单槽位：突发事件互相覆盖，天然合并，避免检索/引用连发两条）。
  let settled = false;
  let graceElapsed = false;
  let pendingStatus: string | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const sentTexts = new Set<string>();
  let statusCount = 0;
  const pendingSends: Promise<void>[] = [];

  const sendStatusNow = (text: string): void => {
    if (settled || statusCount >= MAX_STATUS_MESSAGES || sentTexts.has(text)) return;
    sentTexts.add(text);
    statusCount += 1;
    const task = deps.reply(text).catch((error) => {
      // 状态提示绝不能打断主流程：失败只记日志，最终答案照常发送。
      logTrace(`im.${platform}.status_error`, { error: String(error) }, "error");
    });
    pendingSends.push(task);
  };

  const scheduleFlush = (): void => {
    if (settled || !graceElapsed || !pendingStatus || debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (settled || !pendingStatus) return;
      const text = pendingStatus;
      pendingStatus = null;
      sendStatusNow(text);
    }, STATUS_DEBOUNCE_MS);
  };

  const graceTimer = setTimeout(() => {
    graceElapsed = true;
    if (settled) return;
    if (pendingStatus) {
      const text = pendingStatus;
      pendingStatus = null;
      sendStatusNow(text);
    } else if (statusCount === 0) {
      // 长时间无任何进度事件（如网关解析卡住）：占位提示，避免用户以为机器人掉了。
      sendStatusNow("收到，正在处理，请稍候…");
    }
  }, STATUS_GRACE_MS);
  // 定时器不应拖住进程退出（单测/后台常驻均受益）。
  graceTimer.unref?.();

  const clearTimers = (): void => {
    clearTimeout(graceTimer);
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };

  const handleProgress = (progress: ChatProgressEvent): void => {
    if (settled) return;
    switch (progress.type) {
      case "retrieval":
        pushStep("检索知识库");
        pendingStatus = "已完成知识库检索，正在继续处理…";
        break;
      case "citations":
        if (progress.count > 0) {
          pendingStatus = `已找到 ${progress.count} 段相关资料，正在继续处理…`;
        }
        break;
      case "tool_call":
        pendingStatus = `正在调用 ${friendlyToolName(progress.toolName)}…`;
        break;
      case "tool_result":
        pushStep(`调用 ${friendlyToolName(progress.toolName ?? "工具")}`);
        pendingStatus = `已完成 ${friendlyToolName(progress.toolName ?? "工具")} 调用，正在整理回答…`;
        break;
      case "delta":
        // 生成中：已有更具体的待定状态（工具/检索）时不覆盖。
        if (!pendingStatus) pendingStatus = "正在生成回答…";
        break;
    }
    scheduleFlush();
  };

  function audit(
    input: Pick<
      ImChatAuditInput,
      "answer" | "status" | "error" | "actorName" | "toolCalls" | "citations"
    > & {
      /** 本轮问答结果（失败时为错误上携带的部分结果），用于记录 token 与模型。 */
      chat?: Partial<ChatAnswer>;
    },
  ): void {
    const usage = input.chat?.usage ?? null;
    const model = input.chat?.model ?? null;
    try {
      (deps.recordAudit ?? recordImChatAudit)({
        channelId: config.channelId ?? null,
        channelName: config.name,
        platform,
        sessionId,
        workspace: config.workspaceId ?? null,
        actor: actor ?? null,
        actorName: input.actorName ?? null,
        chatType,
        conversationId: chatId,
        question,
        answer: input.answer,
        status: input.status,
        error: input.error ?? null,
        durationMs: Date.now() - startedAt,
        toolCalls: input.toolCalls ?? 0,
        citations: input.citations ?? 0,
        providerId: model?.providerId ?? null,
        providerName: model?.providerName ?? null,
        providerFormat: model?.providerFormat ?? null,
        model: model?.model ?? null,
        llmRequests: usage?.requests ?? 0,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        totalTokens: usage?.totalTokens ?? 0,
        models: input.chat?.models ?? [],
      });
    } catch (error) {
      // Audit failures must not interrupt replies or trigger a second error reply.
      logTrace(`im.${platform}.audit_error`, { error: String(error) }, "error");
    }
  }

  try {
    const [answer, actorName] = await Promise.all([
      (deps.askChat ?? askChat)({
        baseUrl: config.chatBaseUrl,
        question,
        sessionId,
        sources: config.ragSources,
        topK: config.ragTopK,
        sqlSources: config.sqlSources,
        mcpTools: config.mcpTools,
        ...(accountModel ? { providerId: accountModel.providerId, model: accountModel.model } : {}),
        ...(config.workspaceId ? { workspaceId: config.workspaceId } : {}),
        im: {
          ...(config.channelId ? { channelId: config.channelId } : {}),
          ...(actor ? { actor } : {}),
          chatType,
        },
        onProgress: handleProgress,
      }),
      resolvedActorNamePromise,
    ]);
    settled = true;
    clearTimers();
    // 等待已发出的状态先落定，保证“状态在上、答案在下”的顺序。
    await Promise.allSettled(pendingSends);
    logDebugDuration(`im.${platform}.ask_chat`, startedAt, {
      chatId,
      contentLength: answer.content.length,
    });
    const parts = chunkText(answer.content);
    for (const part of parts.length > 0 ? parts : ["（没有生成回答内容）"]) {
      await deps.reply(part);
    }
    audit({
      answer: parts.length > 0 ? answer.content : "",
      status: "ok",
      actorName,
      toolCalls: answer.toolCalls.length,
      citations: answer.citations,
      chat: answer,
    });
  } catch (error) {
    settled = true;
    clearTimers();
    await Promise.allSettled(pendingSends);
    const message = error instanceof Error ? error.message : String(error);
    logTrace(`im.${platform}.chat_error`, { error: message }, "error");
    const actorName = await resolvedActorNamePromise;
    const suffix =
      completedSteps.length > 0
        ? `（失败前已完成：${completedSteps.join("、").slice(0, 200)}）`
        : "";
    await deps.reply(`抱歉，处理失败：${message.slice(0, 300)}${suffix}`);
    // 失败也可能已消耗 token（流内错误）：用错误上携带的部分结果记账。
    const partial = error instanceof ChatRequestError ? error.partial : undefined;
    audit({ answer: "", status: "error", error: message, actorName, chat: partial });
  }
}
