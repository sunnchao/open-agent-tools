import type { ImBotHandle, ImConfig } from "../types.js";
import { buildImSessionId } from "../types.js";
import { askChat } from "../chatClient.js";
import { chunkText } from "../text.js";
import { recordImChatAudit } from "../audit.js";
import { logDebugDuration, logTrace } from "../../trace.js";
import { parseDingTalkMessagePayload, type DingTalkMessagePayload } from "./message.js";
import { DingTalkStreamClient, type DingTalkStreamClientOptions } from "./streamClient.js";

/** 机器人 webhook 回复超时（毫秒）。 */
const WEBHOOK_TIMEOUT_MS = 10_000;

/** 容错解析 JSON 对象；非对象/坏 JSON 返回 null。 */
function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 便于单测替换的最小 Stream 客户端能力。 */
export interface DingTalkStreamLike {
  connect(): Promise<void>;
  disconnect(): void;
  isConnected(): boolean;
  getLastError?(): string | undefined;
}

export interface DingTalkBotDeps {
  askChat?: typeof askChat;
  createStreamClient?: (options: DingTalkStreamClientOptions) => DingTalkStreamLike;
}

/**
 * 启动钉钉机器人：
 * - Stream 模式长连接订阅 /v1.0/im/bot/messages/get（无需公网回调）
 * - 收到文本消息 → 调本服务 /api/chat（RAG + SQL 问数）→ 通过 sessionWebhook 分片回复
 */
export async function startDingTalkBot(
  config: ImConfig,
  deps: DingTalkBotDeps = {},
): Promise<ImBotHandle> {
  const ask = deps.askChat ?? askChat;
  const createStreamClient =
    deps.createStreamClient ??
    ((options: DingTalkStreamClientOptions): DingTalkStreamLike =>
      new DingTalkStreamClient(options));

  let fatalError: string | undefined;

  const client = createStreamClient({
    clientId: config.appId,
    clientSecret: config.appSecret,
    onMessage: (data: unknown) => handleMessage(data),
  });

  async function handleMessage(data: unknown): Promise<void> {
    let payload: DingTalkMessagePayload;
    try {
      payload = parseDingTalkMessagePayload(data);
    } catch (error) {
      logTrace("im.dingtalk.parse_error", { error: String(error) }, "error");
      return;
    }
    const { event } = payload;
    if (event.text === null || !event.text) return;
    if (event.chatType === "group" && config.requireMention && !event.mentioned) return;

    logTrace("im.dingtalk.receive", {
      chatId: event.chatId,
      chatType: event.chatType,
      text: event.text.slice(0, 120),
    });

    const askChatStartedAt = Date.now();
    // 会话 id 规则见 im/types.ts 的 buildImSessionId：私聊按用户隔离，群聊共享上下文。
    const sessionId = buildImSessionId(
      "dingtalk",
      event.chatId,
      event.chatType,
      event.senderOpenId,
    );
    const actor = event.senderOpenId;
    const actorName = event.senderName;
    try {
      const answer = await ask({
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
      });
      logDebugDuration("im.dingtalk.ask_chat", askChatStartedAt, {
        chatId: event.chatId,
        contentLength: answer.content.length,
      });
      const parts = chunkText(answer.content);
      if (parts.length === 0) {
        await reply(payload, "（没有生成回答内容）");
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
        await reply(payload, part);
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
      logTrace("im.dingtalk.chat_error", { error: message }, "error");
      await reply(payload, `抱歉，处理失败：${message.slice(0, 300)}`);
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
    /** 对话者昵称（钉钉 senderNick；缺失时为 null）。 */
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
        platform: "dingtalk",
        sessionId: input.sessionId,
        workspace: config.workspaceId ?? null,
        // actor 为平台用户 id（senderStaffId），actorName 为 senderNick（调试版可能缺失，保持 null）。
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
      logTrace("im.dingtalk.audit_error", { error: String(auditError) }, "error");
    }
  }

  /** 通过 sessionWebhook 回复文本；所有失败只记录日志，不影响长连接。 */
  async function reply(payload: DingTalkMessagePayload, text: string): Promise<void> {
    const webhook = payload.sessionWebhook;
    if (!webhook) {
      logTrace("im.dingtalk.reply_error", { reason: "sessionWebhook missing" }, "error");
      return;
    }
    if (
      payload.sessionWebhookExpiredTime !== null &&
      Date.now() > payload.sessionWebhookExpiredTime
    ) {
      logTrace(
        "im.dingtalk.reply_error",
        { reason: "sessionWebhook expired", expiredAt: payload.sessionWebhookExpiredTime },
        "error",
      );
      return;
    }
    try {
      const response = await fetch(webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ msgtype: "text", text: { content: text } }),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      const raw = await response.text().catch(() => "");
      if (!response.ok) {
        logTrace(
          "im.dingtalk.reply_error",
          { status: response.status, detail: raw.slice(0, 200) },
          "error",
        );
        return;
      }
      // 钉钉 webhook 通常 HTTP 200 + {errcode:0}，业务失败由 errcode 表达。
      const body = parseJsonObject(raw);
      if (body && typeof body.errcode === "number" && body.errcode !== 0) {
        logTrace(
          "im.dingtalk.reply_error",
          { errcode: body.errcode, errmsg: body.errmsg ?? "" },
          "error",
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logTrace("im.dingtalk.reply_error", { error: message }, "error");
    }
  }

  try {
    await client.connect();
    fatalError = client.getLastError?.();
    logTrace("im.dingtalk.ready", {
      channel: config.name,
      ragSources: config.ragSources,
      sqlSources: config.sqlSources,
    });
  } catch (error) {
    fatalError = error instanceof Error ? error.message : String(error);
    logTrace("im.dingtalk.start_error", { error: fatalError }, "error");
  }

  return {
    stop: () => {
      client.disconnect();
    },
    // 直接读底层连接状态：首次失败后客户端会自动重连，重连成功这里立即恢复 true。
    status: () => {
      const connected = client.isConnected();
      const error = client.getLastError?.() ?? (connected ? undefined : fatalError);
      return { connected, ...(error ? { error } : {}) };
    },
  };
}
