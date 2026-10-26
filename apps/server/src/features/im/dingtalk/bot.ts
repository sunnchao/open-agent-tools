import type { ImBotHandle, ImConfig } from "../types.js";
import { answerImMessage } from "../answerMessage.js";
import { askChat } from "../chatClient.js";
import { logTrace } from "../../../platform/trace.js";
import { parseDingTalkMessagePayload, type DingTalkMessagePayload } from "./message.js";
import { DingTalkStreamClient, type DingTalkStreamClientOptions } from "./streamClient.js";
import {
  recordImAccountInteraction,
  resolveImAccountModel,
  updateImAccountExternalName,
} from "../accounts/store.js";

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

    await answerImMessage(config, event, {
      askChat: ask,
      reply: (text) => reply(payload, text),
      recordAccountInteraction: recordImAccountInteraction,
      updateAccountExternalName: updateImAccountExternalName,
      resolveAccountModel: resolveImAccountModel,
    });
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
