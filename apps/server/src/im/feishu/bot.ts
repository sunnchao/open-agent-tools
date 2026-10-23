import * as lark from "@larksuiteoapi/node-sdk";
import type { ImBotHandle, ImConfig } from "../types.js";
import { answerImMessage } from "../answerMessage.js";
import { parseFeishuMessageEvent } from "./message.js";
import { resolveFeishuSenderName } from "./senderName.js";
import { logTrace } from "../../trace.js";

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
    deps.resolveSenderName ?? ((openId: string) => resolveFeishuSenderName(restClient, openId));

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

    await answerImMessage(config, event, {
      reply: (text) => reply(event.messageId, text),
      resolveSenderName: resolveName,
    });
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
