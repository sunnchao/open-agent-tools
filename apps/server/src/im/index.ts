import type { ImStatus } from "./types.js";
import { createChannel, listChannels } from "./channels/store.js";
import { getChannelStatuses, syncImChannels } from "./channels/index.js";
import { logTrace } from "../trace.js";

let started = false;

/**
 * 兼容旧用法：im_channels 表为空且配置了 FEISHU_APP_ID / FEISHU_APP_SECRET 时，
 * 用环境变量引导创建一条渠道记录，之后所有配置以表中数据为准。
 */
async function seedFromEnvIfEmpty(): Promise<void> {
  if (listChannels().length > 0) return;
  const appId = process.env.FEISHU_APP_ID?.trim();
  const appSecret = process.env.FEISHU_APP_SECRET?.trim();
  if (!appId || !appSecret) return;

  const ragSources = (process.env.RAG_SOURCES ?? "")
    .split(",")
    .map((source) => source.trim())
    .filter(Boolean);
  const rawTopK = Number.parseInt(process.env.RAG_TOP_K ?? "5", 10);

  const channel = createChannel({
    name: "飞书（环境变量引导）",
    platform: "feishu",
    appId,
    appSecret,
    encryptKey: process.env.FEISHU_ENCRYPT_KEY?.trim() || undefined,
    ragSources,
    ragTopK: Number.isFinite(rawTopK) ? Math.min(20, Math.max(1, rawTopK)) : 5,
    requireMention: process.env.FEISHU_REQUIRE_MENTION !== "false",
  });
  logTrace("im.channel.seeded_from_env", { channelId: channel.id, name: channel.name });
}

/** 幂等启动：仅在首次调用时执行。启动失败只记录日志，不影响主服务。 */
export async function startImIfConfigured(): Promise<void> {
  if (started) return;
  started = true;
  try {
    await seedFromEnvIfEmpty();
    await syncImChannels();
  } catch (error) {
    logTrace("im.start_error", { error: String(error) }, "error");
  }
}

export function getImStatus(): ImStatus {
  const channels = getChannelStatuses();
  const first = channels[0];
  const errored = channels.find((channel) => channel.error);
  return {
    enabled: channels.length > 0,
    platform: first?.platform ?? null,
    connected: channels.some((channel) => channel.connected),
    ragSources: first?.ragSources ?? [],
    ragTopK: first?.ragTopK ?? 5,
    channels,
    ...(errored?.error ? { error: errored.error } : {}),
  };
}
