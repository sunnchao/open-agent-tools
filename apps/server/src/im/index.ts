import type { ImConfig, ImStatus } from "./types.js";
import { loadImConfig } from "./config.js";
import { logTrace } from "../trace.js";

let config: ImConfig | null = null;
let handle: { stop: () => void; status: () => { connected: boolean; error?: string } } | null =
  null;

/** 未配置飞书凭据时静默跳过；启动失败只记录日志，不影响主服务。 */
export async function startImIfConfigured(): Promise<void> {
  config = loadImConfig();
  if (!config) {
    logTrace("im.disabled", {
      reason: "FEISHU_APP_ID / FEISHU_APP_SECRET not configured, IM bot disabled",
    });
    return;
  }
  try {
    const { startFeishuBot } = await import("./feishu/bot.js");
    handle = await startFeishuBot(config);
  } catch (error) {
    logTrace("im.start_error", { error: String(error) }, "error");
  }
}

export function getImStatus(): ImStatus {
  const status = handle?.status();
  return {
    enabled: Boolean(config),
    platform: config?.platform ?? null,
    connected: status?.connected ?? false,
    ragSources: config?.ragSources ?? [],
    ragTopK: config?.ragTopK ?? 5,
    ...(status?.error ? { error: status.error } : {}),
  };
}
