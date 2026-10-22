import * as lark from "@larksuiteoapi/node-sdk";
import type { ImBotHandle, ImConfig } from "../types.js";
import { buildImSessionId } from "../types.js";
import { askChat } from "../chatClient.js";
import { chunkText } from "../text.js";
import { parseFeishuMessageEvent } from "./message.js";
import { recordImChatAudit } from "../audit.js";
import { resolveFeishuSenderName } from "./senderName.js";
import { logDebugDuration, logTrace } from "../../trace.js";

export type FeishuBotHandle = ImBotHandle;

export interface FeishuBotDeps {
  /** 姓名解析器（单测注入假实现；默认调通讯录接口，失败返回 null）。 */
  resolveSenderName?: (openId: string) => Promise<string | null>;
}

/**
 * 启动飞书机器人：
 * - WSClient 长连接订阅 im.message.receive_v1（无需公网回调地址）
 * - 收到文本消息 → 调本服务 /api/chat（绑定 RAG sources）→ 分片回复
 * - 对话者姓名按 open_id 调通讯录解析（无权限/超时则留空），随审计落库便于追溯客户
 */
export async function startFeishuBot(
  config: ImConfig,
  deps: FeishuBotDeps = {},
): Promise<FeishuBotHandle> {
  const restClient = new lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: lark.Domain.Feishu,
    loggerLevel: lark.LoggerLevel.error,
  });

  let connected = false;
  let fatalError: string | undefined;

  const dispatcher = new lark.EventDispatcher({
    ...(config.encryptKey ? { encryptKey: config.encryptKey } : {}),
    loggerLevel: lark.LoggerLevel.error,
  }).register({
    "im.message.receive_v1": (data) => {
      void handleMessage(data).catch((error) => {
        logTrace("im.feishu.handle_error", { error: String(error) }, "error");
      });
    },
  });

  const resolveName =
    deps.resolveSenderName ??
    ((openId: string) => resolveFeishuSenderName(restClient, openId));

  const ws = new lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: lark.Domain.Feishu,
    autoReconnect: true,
    loggerLevel: lark.LoggerLevel.error,
    onReady: () => {
      connected = true;
      fatalError = undefined;
      logTrace("im.feishu.ready", {
        channel: config.name,
        ragSources: config.ragSources,
      });
    },
    onError: (error) => {
      connected = false;
      fatalError = error instanceof Error ? error.message : String(error);
      logTrace("im.feishu.error", { error: fatalError }, "error");
    },
  });

  await ws.start({ eventDispatcher: dispatcher });

  async function handleMessage(data: unknown): Promise<void> {
    const event = parseFeishuMessageEvent(data);
    if (!event.messageId || event.text === null) return;
    if (event.chatType === "group" && config.requireMention && !event.mentioned) return;

    logTrace("im.feishu.receive", {
      chatId: event.chatId,
      chatType: event.chatType,
      text: event.text.slice(0, 120),
    });

    const askChatStartedAt = Date.now();
    // 会话 id 规则见 im/types.ts 的 buildImSessionId：私聊按用户隔离，群聊共享上下文。
    const sessionId = buildImSessionId("feishu", event.chatId, event.chatType, event.senderOpenId);
    const actor = event.senderOpenId;
    // 姓名解析与问答并行：通讯录延迟（默认 3s 超时）不拖慢回复；失败只留空，审计照常落 ID。
    const actorNamePromise = actor ? resolveName(actor).catch(() => null) : Promise.resolve(null);
    try {
      const [answer, actorName] = await Promise.all([
        askChat({
          baseUrl: config.chatBaseUrl,
          question: event.text,
          sessionId,
          sources: config.ragSources,
          topK: config.ragTopK,
          sqlSources: config.sqlSources,
          mcpTools: config.mcpTools,
          ...(config.workspaceId ? { workspaceId: config.workspaceId } : {}),
          im: {
            ...(config.channelId ? { channelId: config.channelId } : {}),
            ...(actor ? { actor } : {}),
            chatType: event.chatType,
          },
        }),
        actorNamePromise,
      ]);
      logDebugDuration("im.feishu.ask_chat", askChatStartedAt, {
        chatId: event.chatId,
        contentLength: answer.content.length,
      });
      const parts = chunkText(answer.content);
      if (parts.length === 0) {
        await reply(event.messageId, "（没有生成回答内容）");
        audit({
          sessionId,
          question: event.text,
          answer: "",
          status: "ok",
          durationMs: Date.now() - askChatStartedAt,
          actor,
          actorName,
          chatType: event.chatType,
          conversationId: event.chatId,
          toolCalls: answer.toolCalls.length,
          citations: answer.citations,
        });
        return;
      }
      for (const part of parts) {
        await reply(event.messageId, part);
      }
      audit({
        sessionId,
        question: event.text,
        answer: answer.content,
        status: "ok",
        durationMs: Date.now() - askChatStartedAt,
        actor,
        actorName,
        chatType: event.chatType,
        conversationId: event.chatId,
        toolCalls: answer.toolCalls.length,
        citations: answer.citations,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logTrace("im.feishu.chat_error", { error: message }, "error");
      // 问答失败时姓名解析可能仍在进行：等它落定（已缓存/超时，很快）再写审计。
      const actorName = await actorNamePromise.catch(() => null);
      await reply(event.messageId, `抱歉，处理失败：${message.slice(0, 300)}`);
      audit({
        sessionId,
        question: event.text,
        answer: "",
        status: "error",
        error: message,
        durationMs: Date.now() - askChatStartedAt,
        actor,
        actorName,
        chatType: event.chatType,
        conversationId: event.chatId,
      });
    }
  }

  /**
   * 写 IM 会话审计。**写审计失败绝不能影响回复**：这里只吞异常并记日志。
   */
  function audit(input: {
    sessionId: string;
    question: string;
    answer: string;
    status: "ok" | "error";
    error?: string;
    durationMs: number;
    actor?: string | null;
    /** 对话者姓名（通讯录解析；无权限/超时时为 null）。 */
    actorName?: string | null;
    chatType: "p2p" | "group";
    conversationId: string;
    toolCalls?: number;
    citations?: number;
  }): void {
    try {
      recordImChatAudit({
        channelId: config.channelId ?? null,
        channelName: config.name,
        platform: "feishu",
        sessionId: input.sessionId,
        workspace: config.workspaceId ?? null,
        // actor 为平台用户 id（open_id），actorName 为通讯录姓名（解析失败留空，不臆造）。
        actor: input.actor ?? null,
        actorName: input.actorName ?? null,
        chatType: input.chatType,
        conversationId: input.conversationId,
        question: input.question,
        answer: input.answer,
        status: input.status,
        error: input.error ?? null,
        durationMs: input.durationMs,
        toolCalls: input.toolCalls ?? 0,
        citations: input.citations ?? 0,
      });
    } catch (auditError) {
      logTrace("im.feishu.audit_error", { error: String(auditError) }, "error");
    }
  }

  async function reply(messageId: string, text: string): Promise<void> {
    try {
      await restClient.im.message.reply({
        path: { message_id: messageId },
        data: { content: JSON.stringify({ text }), msg_type: "text" },
      });
    } catch (error) {
      logTrace("im.feishu.reply_error", { error: String(error) }, "error");
    }
  }

  return {
    stop: () => ws.close(),
    status: () => ({ connected, error: fatalError }),
  };
}
