import type { ImMessageEvent } from "../types.js";

/** 钉钉机器人消息回调（/v1.0/im/bot/messages/get）中与本模块相关的字段。 */
interface DingTalkMessageData {
  conversationId?: string;
  conversationType?: string;
  msgId?: string;
  senderStaffId?: string;
  senderId?: string;
  /** 发送者昵称（必填）；线上版本才稳定返回，调试版可能缺失。 */
  senderNick?: string;
  text?: { content?: string };
  msgtype?: string;
  isInAtList?: boolean;
  atUsers?: Array<{ dingtalkId?: string; staffId?: string }>;
  sessionWebhook?: string;
  sessionWebhookExpiredTime?: number | string;
  robotCode?: string;
}

/** 钉钉消息回调的完整载荷：事件 + 回复所需的会话级 webhook。 */
export interface DingTalkMessagePayload {
  event: ImMessageEvent;
  /** 当前会话的回复 webhook；缺失或过期时无法回复。 */
  sessionWebhook: string | null;
  /** webhook 过期时间（毫秒时间戳）；缺失为 null。 */
  sessionWebhookExpiredTime: number | null;
  /** 机器人编码（自定义机器人无此字段）。 */
  robotCode: string | null;
}

/**
 * 剥离消息开头 @机器人 的文本前缀。
 *
 * 钉钉群聊回调的 text.content 形如 `@机器人 你好`。昵称可能含空格，无法可靠区分
 * 昵称边界，因此保守地只剥离开头第一个 `@` 起的连续非空白 token；纯空白则原样返回。
 * 若剥离后为空（用户只 @ 了机器人），返回空串，由上层决定是否忽略。
 */
export function stripDingTalkMentionPrefix(content: string): string {
  const text = content.trim();
  if (!text.startsWith("@")) return text;
  const stripped = text.replace(/^@\S+\s*/, "").trim();
  return stripped;
}

/** 归一化发送者昵称：非空裁剪，缺失/空白返回 null（不臆造）。 */
export function normalizeSenderName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** 把钉钉机器人消息载荷归一化为平台内 ImMessageEvent。 */
export function parseDingTalkMessageEvent(data: unknown): ImMessageEvent {
  return parseDingTalkMessagePayload(data).event;
}

/** 解析钉钉机器人消息载荷，同时保留 sessionWebhook 等平台私有字段。 */
export function parseDingTalkMessagePayload(data: unknown): DingTalkMessagePayload {
  const event = (data ?? {}) as DingTalkMessageData;
  const isText = event.msgtype === "text";
  const rawContent = typeof event.text?.content === "string" ? event.text.content : "";
  const text = isText ? stripDingTalkMentionPrefix(rawContent) || null : null;
  const expired = Number(event.sessionWebhookExpiredTime);
  const atUsers = Array.isArray(event.atUsers) ? event.atUsers : [];
  return {
    event: {
      platform: "dingtalk",
      messageId: event.msgId ?? "",
      chatId: event.conversationId ?? "",
      chatType: event.conversationType === "1" ? "p2p" : "group",
      senderOpenId: event.senderStaffId ?? event.senderId ?? null,
      senderName: normalizeSenderName(event.senderNick),
      text,
      mentioned: event.isInAtList === true || atUsers.length > 0,
    },
    sessionWebhook:
      typeof event.sessionWebhook === "string" && event.sessionWebhook
        ? event.sessionWebhook
        : null,
    sessionWebhookExpiredTime: Number.isFinite(expired) && expired > 0 ? expired : null,
    robotCode: typeof event.robotCode === "string" && event.robotCode ? event.robotCode : null,
  };
}
