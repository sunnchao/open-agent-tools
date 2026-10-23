/** IM 协同模块共享类型：平台内与具体 IM 平台（飞书/钉钉）解耦的消息模型。 */

export type ImPlatform = "feishu" | "dingtalk";

/** IM 会话类型；私聊按用户拆会话，群聊共享会话。 */
export type ImChatType = "p2p" | "group";

/** IM 发送者外部 ID 的来源；用于后台展示，不作为账号唯一键。 */
export type ImExternalUserIdType =
  "feishu_open_id" | "dingtalk_staff_id" | "dingtalk_sender_id" | "dingtalk_user_id";

/**
 * IM 来源标识请求头（由本机 IM bot 注入，服务端 chat.ts 读取后给会话打 source='im'）。
 *
 * 信任边界：这些头只由同进程的 IM bot 写入，Agent Server 当前没有用户隔离
 * （README 已记录该局限），因此它们只用于**归属标注**，不是强安全隔离。
 */
export const IM_CHANNEL_HEADER = "x-im-channel";
export const IM_ACTOR_HEADER = "x-im-actor";
export const IM_CHAT_TYPE_HEADER = "x-im-chat-type";

export const IM_PLATFORMS: ImPlatform[] = ["feishu", "dingtalk"];

export function isImPlatform(value: unknown): value is ImPlatform {
  return typeof value === "string" && (IM_PLATFORMS as string[]).includes(value);
}

/** IM 渠道绑定的 MCP 工具；与 /api/chat 的 resources.mcpTools 结构一致（保持 IM 模块零耦合）。 */
export interface ImMcpToolBinding {
  serviceSlug: string;
  toolName: string;
}

/**
 * 构造 IM 会话 id。
 *
 * 规则（IM 会话与 Web 会话必须互不可见，故 id 必须带平台与用户维度）：
 * - 私聊（p2p）：`{platform}:{conversationId}:u:{actor}`
 *   每个平台用户一条独立会话，不同人私聊互不可见。
 * - 群聊（group）：`{platform}:{conversationId}`
 *   群上下文共享——群成员需要看到同一段问答历史，所以 actor 不进 sessionId；
 *   但审计记录仍逐条带 actor，审计里能看清谁问了什么。
 *
 * 抽成纯函数便于单测，也便于前端/文档引用同一套规则。
 */
export function buildImSessionId(
  platform: ImPlatform,
  conversationId: string,
  chatType: "p2p" | "group",
  actor: string | null | undefined,
): string {
  const base = `${platform}:${conversationId}`;
  if (chatType === "group") return base;
  const normalizedActor = actor?.trim();
  // 私聊拿不到平台用户 id 时退化为独立后缀，避免多个匿名用户共用一条会话。
  return normalizedActor ? `${base}:u:${normalizedActor}` : `${base}:u:anonymous`;
}

export interface ImConfig {
  /** 渠道显示名（日志用）。 */
  name: string;
  /** 渠道 id（审计与 session 归属用）。 */
  channelId?: string;
  platform: ImPlatform;
  appId: string;
  appSecret: string;
  encryptKey?: string;
  /** 机器人绑定的 RAG 知识库 source 白名单；为空时不检索知识库。 */
  ragSources: string[];
  ragTopK: number;
  /** 机器人绑定的 SQL 问数数据源 id 列表；为空时不注入问数工具。 */
  sqlSources: string[];
  /** 机器人绑定的 MCP 工具；为空时不向 /api/chat 传 mcpTools。 */
  mcpTools: ImMcpToolBinding[];
  /** 群聊中是否要求 @ 机器人后才响应（私聊始终响应）。 */
  requireMention: boolean;
  /** 调用本服务 /api/chat 的自环地址。 */
  chatBaseUrl: string;
  /** 渠道所属 workspace；缺省落到默认空间。 */
  workspaceId?: string;
}

/** 运行中的机器人实例句柄（飞书/钉钉共用）。 */
export interface ImBotHandle {
  stop(): void;
  status(): { connected: boolean; error?: string };
}

export interface ImMessageEvent {
  platform: "feishu" | "dingtalk";
  messageId: string;
  chatId: string;
  chatType: ImChatType;
  senderOpenId: string | null;
  /** 平台发送者 ID 类型；历史/测试事件缺失时由平台适配层兜底。 */
  senderIdType?: ImExternalUserIdType | null;
  /** 对话者可读名称（钉钉 senderNick / 飞书通讯录姓名；拿不到时为 null，仅用于审计展示与追溯）。 */
  senderName: string | null;
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
  sqlSources: string[];
  mcpTools: ImMcpToolBinding[];
  ragTopK: number;
  requireMention: boolean;
  enabled: boolean;
  /** 渠道所属 workspace。 */
  workspaceId: string;
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
