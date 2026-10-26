import { logTrace } from "../../../platform/trace.js";
import { trimmedString as normalizeFeishuUserName } from "@open-agent-tools/api-contracts/values";

/**
 * 通讯录姓名解析所需的最小客户端能力（`lark.Client` 的结构子集）。
 *
 * 只声明用到的 `contact.user.get`，便于单测注入假实现，避免引入真实 SDK。
 */
export interface FeishuContactClient {
  contact: {
    user: {
      get: (payload: {
        params?: { user_id_type?: "user_id" | "union_id" | "open_id" };
        path: { user_id: string };
      }) => Promise<{
        code?: number;
        msg?: string;
        data?: { user?: { name?: string } };
      }>;
    };
  };
}

/** 姓名缓存条目：成功与失败都缓存，避免每条消息都打一次通讯录接口。 */
interface NameCacheEntry {
  name: string | null;
  expiresAt: number;
}

/** open_id → 姓名缓存（进程内，容量有界，LRU 近似：超限时清掉最早一批）。 */
const nameCache = new Map<string, NameCacheEntry>();

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_SIZE = 1000;

/** 测试用：清空进程内姓名缓存。 */
export function clearFeishuSenderNameCache(): void {
  nameCache.clear();
}

function readCache(openId: string, now: number): { hit: boolean; name: string | null } {
  const entry = nameCache.get(openId);
  if (!entry) return { hit: false, name: null };
  if (entry.expiresAt <= now) {
    nameCache.delete(openId);
    return { hit: false, name: null };
  }
  // 命中则移到末尾（近似 LRU），超限淘汰时优先清掉最早的。
  nameCache.delete(openId);
  nameCache.set(openId, entry);
  return { hit: true, name: entry.name };
}

function writeCache(openId: string, name: string | null, ttlMs: number, now: number): void {
  if (nameCache.size >= MAX_CACHE_SIZE) {
    const overflow = nameCache.size - MAX_CACHE_SIZE + 1;
    let removed = 0;
    for (const key of nameCache.keys()) {
      nameCache.delete(key);
      removed += 1;
      if (removed >= overflow) break;
    }
  }
  nameCache.set(openId, { name, expiresAt: now + ttlMs });
}

/** 归一化通讯录姓名：非空裁剪，缺失/空白返回 null（不臆造）。 */
export { normalizeFeishuUserName };

export interface ResolveFeishuSenderNameOptions {
  /** 通讯录接口超时（毫秒），默认 3000；超时返回 null，不阻塞问答。 */
  timeoutMs?: number;
  /** 姓名缓存 TTL（毫秒），默认 10 分钟。 */
  cacheTtlMs?: number;
  /** 时间源（单测注入）。 */
  now?: () => number;
}

/**
 * 按 open_id 解析飞书用户姓名（`contact.user.get`，需通讯录权限）。
 *
 * 失败一律返回 null（无权限/超时/用户不存在/接口报错），调用方直接把 null
 * 写进审计 `actorName` 即可。成功与失败都进缓存，避免高频打通讯录接口。
 */
export async function resolveFeishuSenderName(
  client: FeishuContactClient,
  openId: string,
  options: ResolveFeishuSenderNameOptions = {},
): Promise<string | null> {
  const timeoutMs = options.timeoutMs ?? 3000;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const nowMs = now();
  const trimmed = openId?.trim();
  if (!trimmed) return null;

  const cached = readCache(trimmed, nowMs);
  if (cached.hit) return cached.name;

  let name: string | null = null;
  try {
    const response = await Promise.race([
      client.contact.user.get({
        params: { user_id_type: "open_id" },
        path: { user_id: trimmed },
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("contact.user.get timed out")), timeoutMs);
      }),
    ]);
    if (response?.code !== 0) {
      logTrace(
        "im.feishu.sender_name_error",
        { code: response?.code ?? -1, msg: (response?.msg ?? "").slice(0, 120) },
        "warn",
      );
    } else {
      name = normalizeFeishuUserName(response?.data?.user?.name);
    }
  } catch (error) {
    logTrace("im.feishu.sender_name_error", { error: String(error).slice(0, 120) }, "warn");
    name = null;
  }
  writeCache(trimmed, name, cacheTtlMs, nowMs);
  return name;
}
