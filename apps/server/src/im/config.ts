import { port } from "../config.js";
import type { ImConfig } from "./types.js";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

/**
 * 从环境变量加载 IM 配置。未配置飞书应用凭据时返回 null（机器人不启动）。
 *
 * 环境变量：
 * - FEISHU_APP_ID / FEISHU_APP_SECRET：飞书自建应用凭据（必填，二者缺一即禁用）
 * - FEISHU_ENCRYPT_KEY：事件解密密钥（可选）
 * - FEISHU_REQUIRE_MENTION：群聊是否要求 @ 机器人（默认 true）
 * - RAG_SOURCES：机器人绑定的知识库 source 白名单，逗号分隔
 * - RAG_TOP_K：检索条数，默认 5
 */
export function loadImConfig(): ImConfig | null {
  const appId = process.env.FEISHU_APP_ID?.trim();
  const appSecret = process.env.FEISHU_APP_SECRET?.trim();
  if (!appId || !appSecret) return null;

  const rawTopK = Number.parseInt(process.env.RAG_TOP_K ?? "5", 10);
  const ragSources = (process.env.RAG_SOURCES ?? "")
    .split(",")
    .map((source) => source.trim())
    .filter(Boolean);

  return {
    platform: "feishu",
    appId,
    appSecret,
    encryptKey: process.env.FEISHU_ENCRYPT_KEY?.trim() || undefined,
    ragSources,
    ragTopK: clamp(rawTopK, 1, 20),
    requireMention: process.env.FEISHU_REQUIRE_MENTION !== "false",
    chatBaseUrl: `http://127.0.0.1:${port}`,
  };
}
