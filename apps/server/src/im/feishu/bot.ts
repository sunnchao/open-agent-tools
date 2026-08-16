import * as lark from "@larksuiteoapi/node-sdk";
import type { ImConfig } from "../types.js";
import { askChat } from "../chatClient.js";
import { chunkText } from "../text.js";
import { parseFeishuMessageEvent } from "./message.js";
import { logTrace } from "../../trace.js";

export interface FeishuBotHandle {
  stop: () => void;
  status: () => { connected: boolean; error?: string };
}

/**
 * 启动飞书机器人：
 * - WSClient 长连接订阅 im.message.receive_v1（无需公网回调地址）
 * - 收到文本消息 → 调本服务 /api/chat（绑定 RAG sources）→ 分片回复
 */
export async function startFeishuBot(config: ImConfig): Promise<FeishuBotHandle> {
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

    try {
      const answer = await askChat({
        baseUrl: config.chatBaseUrl,
        question: event.text,
        sessionId: `feishu:${event.chatId}`,
        sources: config.ragSources,
        topK: config.ragTopK,
      });
      const parts = chunkText(answer.content);
      if (parts.length === 0) {
        await reply(event.messageId, "（没有生成回答内容）");
        return;
      }
      for (const part of parts) {
        await reply(event.messageId, part);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logTrace("im.feishu.chat_error", { error: message }, "error");
      await reply(event.messageId, `抱歉，处理失败：${message.slice(0, 300)}`);
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
