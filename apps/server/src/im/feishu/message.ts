import type { ImMessageEvent } from "../types.js";

/** 飞书 im.message.receive_v1 事件中与本模块相关的字段。 */
interface FeishuMessageEventData {
  sender?: { sender_id?: { open_id?: string } };
  message?: {
    message_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    mentions?: Array<{ id?: { open_id?: string } }>;
  };
}

/** 解析文本消息 content（JSON 字符串，如 `{"text":"..."}`），非文本返回 null。 */
export function parseFeishuTextContent(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
    return text ? text : null;
  } catch {
    return null;
  }
}

/** 把飞书消息事件归一化为平台内 ImMessageEvent。 */
export function parseFeishuMessageEvent(data: unknown): ImMessageEvent {
  const event = (data ?? {}) as FeishuMessageEventData;
  const message = event.message ?? {};
  return {
    platform: "feishu",
    messageId: message.message_id ?? "",
    chatId: message.chat_id ?? "",
    chatType: message.chat_type === "group" ? "group" : "p2p",
    senderOpenId: event.sender?.sender_id?.open_id ?? null,
    senderIdType: "feishu_open_id",
    // 飞书事件本身不带昵称；bot 层按 open_id 调通讯录解析（无权限/超时则留空）。
    senderName: null,
    text: message.message_type === "text" ? parseFeishuTextContent(message.content ?? "") : null,
    mentioned: (message.mentions ?? []).length > 0,
  };
}
