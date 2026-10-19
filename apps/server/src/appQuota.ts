import { openDb } from "./db.js";
import { logTrace } from "./trace.js";
import type { PublishedApp } from "./publishedApps.js";

export type QuotaRejection = "rate_limited" | "budget_exhausted";

export interface QuotaCheck {
  ok: boolean;
  reason?: QuotaRejection;
  /** 剩余额度信息，便于前端提示与排障。 */
  retryAfterSeconds?: number;
  usedTokensToday?: number;
  dailyTokenBudget?: number;
}

// 分钟窗口内的请求时间戳（进程内）。单实例部署足够；多实例需换 Redis。
const rateBuckets = new Map<string, number[]>();

function nowMs(): number {
  return Date.now();
}

function startOfToday(): number {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** 今日已消耗 token（按 workspace + 会话前缀归集到应用）。 */
export function tokensUsedToday(app: PublishedApp): number {
  // 员工侧会话 id 形如 `<slug>:<localId>`，这里按前缀统计该应用的消耗。
  const row = openDb()
    .prepare(
      `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS used
       FROM usage_events
       WHERE kind = 'chat' AND created_at >= ? AND session_id LIKE ?`,
    )
    .get(startOfToday(), `${app.slug}:%`) as { used: number };
  return Number(row?.used ?? 0);
}

/**
 * 检查一次对话请求是否放行。
 *
 * - 每分钟请求数：进程内滑动窗口，超限返回 `rate_limited` + 建议重试秒数；
 * - 每日 token 预算：按应用今日累计 token，达到预算即拒绝（`budget_exhausted`）。
 *
 * 预算为 0 表示不限。这里刻意「先扣后查」——限流是防滥用，不是精确计费。
 */
export function checkAppQuota(app: PublishedApp): QuotaCheck {
  const current = nowMs();

  if (app.rateLimitPerMinute > 0) {
    const windowStart = current - 60_000;
    const hits = (rateBuckets.get(app.id) ?? []).filter((ts) => ts > windowStart);
    if (hits.length >= app.rateLimitPerMinute) {
      rateBuckets.set(app.id, hits);
      const oldest = hits[0] ?? current;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + 60_000 - current) / 1000));
      logTrace(
        "app_quota.rate_limited",
        { slug: app.slug, limit: app.rateLimitPerMinute, hits: hits.length },
        "warn",
      );
      return { ok: false, reason: "rate_limited", retryAfterSeconds };
    }
    hits.push(current);
    rateBuckets.set(app.id, hits);
    // 防止长期运行后 Map 无限增长：超过阈值时清理空窗口。
    if (rateBuckets.size > 1_000) {
      for (const [id, timestamps] of rateBuckets) {
        const alive = timestamps.filter((ts) => ts > windowStart);
        if (alive.length === 0) rateBuckets.delete(id);
        else rateBuckets.set(id, alive);
      }
    }
  }

  if (app.dailyTokenBudget > 0) {
    const used = tokensUsedToday(app);
    if (used >= app.dailyTokenBudget) {
      logTrace(
        "app_quota.budget_exhausted",
        { slug: app.slug, used, budget: app.dailyTokenBudget },
        "warn",
      );
      return {
        ok: false,
        reason: "budget_exhausted",
        usedTokensToday: used,
        dailyTokenBudget: app.dailyTokenBudget,
      };
    }
  }

  return { ok: true };
}

/** 供测试重置进程内限流状态。 */
export function resetAppQuotaForTest(): void {
  rateBuckets.clear();
}
