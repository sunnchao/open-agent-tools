import { port } from "../../config.js";
import { logTrace } from "../../trace.js";
import type { ImConfig } from "../types.js";
import { getChannel, listChannels, type ImChannelWithSecret } from "./store.js";

export interface ImBotHandle {
  stop: () => void;
  status: () => { connected: boolean; error?: string };
}

/** 运行中的机器人实例：channelId → handle。 */
const running = new Map<string, ImBotHandle>();

export function channelToConfig(channel: ImChannelWithSecret): ImConfig {
  return {
    name: channel.name,
    platform: channel.platform,
    appId: channel.appId,
    appSecret: channel.appSecret ?? "",
    encryptKey: channel.encryptKey ?? undefined,
    ragSources: channel.ragSources,
    ragTopK: channel.ragTopK,
    requireMention: channel.requireMention,
    chatBaseUrl: `http://127.0.0.1:${port}`,
  };
}

async function startBot(channel: ImChannelWithSecret): Promise<ImBotHandle> {
  if (channel.platform === "feishu") {
    const { startFeishuBot } = await import("../feishu/bot.js");
    return startFeishuBot(channelToConfig(channel));
  }
  throw new Error(`unsupported IM platform: ${channel.platform}`);
}

/**
 * 同步运行实例与启用的渠道记录：停掉已停用/删除的渠道，启动新启用/变更的渠道。
 * 幂等，可在 CRUD 后直接调用。
 */
export async function syncImChannels(): Promise<void> {
  const enabled = listChannels();
  const enabledIds = new Set(enabled.map((channel) => channel.id));

  for (const [id, handle] of running) {
    if (!enabledIds.has(id)) {
      try {
        handle.stop();
      } catch (error) {
        logTrace("im.channel.stop_error", { channelId: id, error: String(error) }, "error");
      }
      running.delete(id);
      logTrace("im.channel.stopped", { channelId: id });
    }
  }

  for (const channel of enabled) {
    if (running.has(channel.id)) continue;
    const secret = getChannel(channel.id, { includeDisabled: true });
    if (!secret) continue;
    try {
      running.set(channel.id, await startBot(secret));
      logTrace("im.channel.started", {
        channelId: channel.id,
        name: channel.name,
        platform: channel.platform,
      });
    } catch (error) {
      logTrace("im.channel.start_error", { channelId: channel.id, error: String(error) }, "error");
    }
  }
}

/** 重启单个渠道（CRUD 变更后调用），保持其它渠道连接不受影响。 */
export async function restartChannel(id: string): Promise<void> {
  const existing = running.get(id);
  if (existing) {
    try {
      existing.stop();
    } catch (error) {
      logTrace("im.channel.stop_error", { channelId: id, error: String(error) }, "error");
    }
    running.delete(id);
  }
  const channel = getChannel(id, { includeDisabled: true });
  if (!channel || !channel.enabled) return;
  try {
    running.set(id, await startBot(channel));
    logTrace("im.channel.restarted", { channelId: id, name: channel.name });
  } catch (error) {
    logTrace("im.channel.restart_error", { channelId: id, error: String(error) }, "error");
  }
}

export function getChannelStatuses(): Array<{
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
}> {
  return listChannels({ includeDisabled: true }).map((channel) => {
    const status = running.get(channel.id)?.status();
    return {
      ...channel,
      connected: status?.connected ?? false,
      ...(status?.error ? { error: status.error } : {}),
    };
  });
}

export function stopAllChannels(): void {
  for (const [id, handle] of running) {
    try {
      handle.stop();
    } catch {
      // 忽略停止失败
    }
    running.delete(id);
  }
}
