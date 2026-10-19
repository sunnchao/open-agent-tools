import type { DraftSlots } from "./types.js";
import type { CaliberConfig } from "./caliber-config.js";
import {
  preQueryResolve,
  type CaliberPatterns,
  type ResolveContext,
  type ResolveOutcome,
} from "./preQueryResolve.js";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compilePattern(source: string): RegExp {
  try {
    return new RegExp(source);
  } catch (cause) {
    throw new Error(`无效的正则表达式: ${source}`, { cause });
  }
}

/** 词表 → 抽取正则（转义 + 最长优先），空词表返回 undefined 表示沿用内置默认 */
function buildWordsRegex(words: string[]): RegExp | undefined {
  const escaped = words
    .map((w) => escapeRegExp(w))
    .filter((w) => w.length > 0)
    .sort((a, b) => b.length - a.length);
  return escaped.length > 0 ? new RegExp(`(${escaped.join("|")})`) : undefined;
}

function buildIntentRegex(config: CaliberConfig): RegExp | undefined {
  const sources = config.intent.queryPatterns.map((p) => `(?:${compilePattern(p).source})`);
  const keywords = config.intent.keywords.map((k) => escapeRegExp(k));
  const all = [...sources, ...keywords];
  return all.length > 0 ? new RegExp(all.join("|")) : undefined;
}

function buildPatterns(config: CaliberConfig): CaliberPatterns {
  const slots: CaliberPatterns["slots"] = {};
  const expenseRe = buildWordsRegex(config.expense.patterns.flatMap((p) => p.words));
  if (expenseRe) slots.expense = expenseRe;
  const statusRe = buildWordsRegex(config.status.patterns.flatMap((p) => p.words));
  if (statusRe) slots.status = statusRe;
  const intentRe = buildIntentRegex(config);
  if (intentRe) slots.intent = intentRe;
  return {
    slots,
    expense: config.expense.patterns.length > 0 ? config.expense.patterns : undefined,
    status: config.status.patterns.length > 0 ? config.status.patterns : undefined,
  };
}

/**
 * 口径工厂：按配置在创建期编译所有正则（配置非法立即抛错），
 * 返回与 preQueryResolve 同构的解析函数；ctx 仅用于运行期覆盖
 * （now / authorizedOrgs / llmExtract / 默认值），模式以工厂配置为准。
 */
export function createCaliberResolver(
  config: CaliberConfig,
): (utterance: string, partial?: DraftSlots, ctx?: Partial<ResolveContext>) => Promise<ResolveOutcome> {
  const patterns = buildPatterns(config);

  return async (utterance, partial = {}, ctx = {}) =>
    preQueryResolve(utterance, partial, {
      orgDirectory: config.org.directory,
      timezone: ctx.timezone ?? config.date.timezone,
      expenseDefault: ctx.expenseDefault ?? config.expense.fallback,
      statusDefault: ctx.statusDefault ?? config.status.fallback,
      timeFieldDefault: ctx.timeFieldDefault ?? config.defaults.timeField,
      patterns,
      authorizedOrgs: ctx.authorizedOrgs,
      llmExtract: ctx.llmExtract,
      now: ctx.now,
    });
}
