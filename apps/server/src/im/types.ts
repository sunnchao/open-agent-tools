/** IM 协同模块共享类型：平台内与具体 IM 平台（飞书/钉钉）解耦的消息模型。 */

export type ImPlatform = "feishu" | "dingtalk";

export const IM_PLATFORMS: ImPlatform[] = ["feishu", "dingtalk"];

export function isImPlatform(value: unknown): value is ImPlatform {
  return typeof value === "string" && (IM_PLATFORMS as string[]).includes(value);
}

export interface ImConfig {
  /** 渠道显示名（日志用）。 */
  name: string;
  platform: ImPlatform;
  appId: string;
  appSecret: string;
  encryptKey?: string;
  /** 机器人绑定的 RAG 知识库 source 白名单；为空时不检索知识库。 */
  ragSources: string[];
  ragTopK: number;
  /** 群聊中是否要求 @ 机器人后才响应（私聊始终响应）。 */
  requireMention: boolean;
  /** 调用本服务 /api/chat 的自环地址。 */
  chatBaseUrl: string;
}

export interface ImMessageEvent {
  platform: "feishu";
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  senderOpenId: string | null;
  /** 非文本消息或解析失败时为 null。 */
  text: string | null;
  /** 消息中是否 @ 了机器人（群聊判断用）。 */
  mentioned: boolean;
}

export interface ImChannelStatus {
  id: string;
  name: string;
  platform: string;
  appId: string;
  appSecretMasked: string | null;
  ragSources: string[];
  ragTopK: number;
  requireMention: boolean;
  enabled: boolean;
  connected: boolean;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ImStatus {
  enabled: boolean;
  platform: string | null;
  connected: boolean;
  ragSources: string[];
  ragTopK: number;
  channels: ImChannelStatus[];
  error?: string;
}
