/**
 * IM 会话 → 记忆作用域解析。
 *
 * 会话键规则见 `im/types.ts:buildImSessionId`：
 * - 私聊 `{platform}:{conversationId}:u:{actor}` → person 作用域；
 * - 群聊 `{platform}:{conversationId}` → group 作用域。
 *
 * 这里只做“从既有键反推作用域”，不改会话键本身（兼容历史数据）。
 */
import type { ImChatType, ImPlatform } from "../im/types.js";

export interface ImMemoryScope {
  platform: ImPlatform | null;
  conversationId: string;
  chatType: ImChatType;
  /** 私聊的 canonical person 键；群聊为 null。 */
  personKey: string | null;
  /** 群作用域键（`platform:conversationId`）；私聊为 null。 */
  groupKey: string | null;
  /** 私聊且拿不到 actor 时为 true：禁止写入个人事实。 */
  anonymous: boolean;
}

export function parseImSessionScope(
  sessionId: string,
  actor: string | null | undefined,
  chatTypeHeader?: string | null,
): ImMemoryScope | null {
  const parts = sessionId.split(":");
  const platform = parts[0];
  if (platform !== "feishu" && platform !== "dingtalk") return null;
  const isPrivate = parts.includes("u");
  const chatType: ImChatType =
    chatTypeHeader === "group" || chatTypeHeader === "p2p"
      ? chatTypeHeader
      : isPrivate
        ? "p2p"
        : "group";
  const conversationId = parts.slice(1, isPrivate ? parts.indexOf("u") : undefined).join(":");
  if (!conversationId) return null;

  if (chatType === "group") {
    return {
      platform,
      conversationId,
      chatType,
      personKey: null,
      groupKey: `${platform}:${conversationId}`,
      anonymous: false,
    };
  }
  const normalizedActor = actor?.trim();
  return {
    platform,
    conversationId,
    chatType,
    personKey: normalizedActor
      ? `person:${platform}:${conversationId}:${normalizedActor}`
      : null,
    groupKey: null,
    anonymous: !normalizedActor,
  };
}
