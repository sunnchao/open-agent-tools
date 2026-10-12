/**
 * Schema 渐进式注入：把 enriched catalog 渲染成 LLM 可用的上下文。
 *
 * 设计（对应 schema-catalog 的 Level 0/1/2）：
 * - Level 0：常驻骨架（表名 + 注释），几百 token；
 * - Level 1：意图预注册选表（确定性）或关键词检索选表（探索式兜底）；
 * - Level 2：按表分档渲染（required+common，剔除敏感字段）。
 *
 * catalog 加载：优先环境变量 SCHEMA_CATALOG_PATH，否则用包内默认 enriched 文件；
 * 无文件时优雅降级为"未启用 schema 注入"（不阻断聊天）。
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  renderSkeleton,
  renderTableSchemaTiered,
  searchTables,
  type SchemaCatalog,
} from "@open-agent-tools/schema-catalog";

/** 意图预注册表：意图 → 必用表（配合 query-resolver 口径字典扩展）。 */
const INTENT_TABLES: Record<string, string[]> = {
  log_query: ["logs"],
  user_query: ["users", "tokens", "logs"],
  token_query: ["tokens", "users"],
  channel_query: ["channels"],
  order_query: ["orders", "top_ups", "payments"],
  quota_query: ["quota_data", "statistics", "users"],
  redemption_query: ["redemptions"],
  model_query: ["models", "prices", "abilities"],
};

export interface SchemaInjection {
  enabled: boolean;
  /** Level 0 骨架（表名+注释）。 */
  skeleton: string;
  /** 按意图/关键词选中的表完整渲染（Level 1+2）。 */
  selected: string;
  /** 本次注入的表名列表（trace 用）。 */
  tableNames: string[];
  /** 注入的 token 估算。 */
  estimatedTokens: number;
}

let cachedCatalog: SchemaCatalog | null = null;
let catalogError: string | null = null;

function defaultCatalogPath(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    process.env.SCHEMA_CATALOG_PATH,
    path.resolve(here, "../../../packages/schema-catalog/schema-catalog.enriched.json"),
    path.resolve(process.cwd(), "packages/schema-catalog/schema-catalog.enriched.json"),
  ].filter(Boolean) as string[];
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

/** 懒加载 catalog（进程内缓存，文件缺失优雅降级）。 */
export function loadCatalog(): SchemaCatalog | null {
  if (cachedCatalog) return cachedCatalog;
  if (catalogError) return null;
  try {
    const p = defaultCatalogPath();
    const raw = readFileSync(p, "utf8");
    cachedCatalog = JSON.parse(raw) as SchemaCatalog;
    return cachedCatalog;
  } catch (err) {
    catalogError = err instanceof Error ? err.message : String(err);
    console.warn(`[schema-inject] catalog 加载失败，schema 注入停用: ${catalogError}`);
    return null;
  }
}

export type RowLimitIntent =
  | { kind: "limited"; limit: number }
  | { kind: "all" }
  | { kind: "unspecified" };

const ROW_LIMIT_CAP = 100;
const CN_DIGIT: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 解析「10 / 十 / 二十 / 一百」这类条数。无法解析时返回 undefined。 */
function parseCount(raw: string): number | undefined {
  const text = raw.trim();
  if (/^\d+$/.test(text)) return Number(text);
  if (text === "十") return 10;
  if (text === "百" || text === "一百") return 100;
  const tens = text.match(/^([一二两三四五六七八九])?十([一二两三四五六七八九])?$/);
  if (tens) return (tens[1] ? CN_DIGIT[tens[1]]! : 1) * 10 + (tens[2] ? CN_DIGIT[tens[2]]! : 0);
  return CN_DIGIT[text];
}

/**
 * 识别结果条数口径，与业务表意图独立。
 * limited：用户给出了条数；all：明确要全部；unspecified：两者都没说，需要确认。
 */
export function detectRowLimitIntent(query: string): RowLimitIntent {
  const turns = query
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const turn of [...turns].reverse()) {
    const intent = detectSingleRowLimitIntent(turn);
    if (intent.kind !== "unspecified") return intent;
  }
  return { kind: "unspecified" };
}

function detectSingleRowLimitIntent(query: string): RowLimitIntent {
  const trimmed = query.trim();
  if (/^(?:全部|所有|全量)$/.test(trimmed)) return { kind: "all" };
  const bareCount = trimmed.match(/^([0-9]+|[一二两三四五六七八九十百]+)\s*(?:条|个|名|位|行|笔)?$/);
  const bareLimit = bareCount ? parseCount(bareCount[1]!) : undefined;
  if (bareLimit !== undefined && bareLimit > 0) {
    return { kind: "limited", limit: Math.min(bareLimit, ROW_LIMIT_CAP) };
  }

  const all =
    /(?:查询|列出|导出|返回|显示|看看)?\s*(?:全部|所有|全量)(?:数据|记录|结果|用户|订单|日志)?/;
  if (all.test(query) && !/(?:不是|不要|除了)\s*(?:全部|所有)/.test(query)) return { kind: "all" };

  const counted = query.match(
    /(?:前|最近|最新|最后|top|limit)\s*([0-9]+|[一二两三四五六七八九十百]+)\s*(?:条|个|名|位|行|笔)?|(?:^|[^0-9一二两三四五六七八九十百])([0-9]+|[一二两三四五六七八九十百]+)\s*(?:条|个|名|位|行|笔)/i,
  );
  const raw = counted?.[1] ?? counted?.[2];
  const limit = raw ? parseCount(raw) : undefined;
  if (limit !== undefined && limit > 0) {
    return { kind: "limited", limit: Math.min(limit, ROW_LIMIT_CAP) };
  }
  return { kind: "unspecified" };
}

/** 未指定条数时的确认话术。默认建议 100，用户仍可改口要全部或其它条数。 */
export function rowLimitClarifying(): string {
  return `请确认需要查询多少条？默认返回最近 ${ROW_LIMIT_CAP} 条；也可以回复「全部」或指定其它条数。`;
}

/** 根据查询文本匹配意图（关键词启发式，可被 query-resolver 替换）。 */
export function detectIntent(query: string): string | undefined {
  const q = query.toLowerCase();
  // 顺序即优先级：更具体的意图放前面（避免"渠道的调用量"被误判为 log_query）
  const rules: Array<[string, RegExp]> = [
    ["redemption_query", /(兑换码|兑换|充值码|redemption)/],
    ["model_query", /(模型价格|定价|价格|模型能力|模型列表)/],
    ["order_query", /(订单|充值|支付|购买|订阅|充值记录)/],
    ["token_query", /(令牌|api\s*key|密钥|token)/],
    ["channel_query", /(渠道|通道|供应商|上游)/],
    ["user_query", /(用户|账号|注册|活跃|用户列表)/],
    ["quota_query", /(额度|quota|消耗|余额)/],
    ["log_query", /(日志|消费|调用|请求|错误|用量|使用记录)/],
  ];
  for (const [intent, re] of rules) {
    if (re.test(q)) return intent;
  }
  return undefined;
}

/**
 * 构建 schema 注入内容：骨架 + 选中表完整 schema。
 * query 为空时只注入骨架（Level 0）。
 */
export function buildSchemaInjection(query: string | undefined): SchemaInjection {
  const catalog = loadCatalog();
  if (!catalog) {
    return { enabled: false, skeleton: "", selected: "", tableNames: [], estimatedTokens: 0 };
  }

  const skeleton = renderSkeleton(catalog);
  const intent = query ? detectIntent(query) : undefined;
  let selected: string;
  let tableNames: string[];

  if (intent && INTENT_TABLES[intent]) {
    // 确定性：意图预注册
    const byName = new Map(catalog.tables.map((t) => [t.table.name, t]));
    tableNames = INTENT_TABLES[intent]!.filter((n) => byName.has(n));
    selected = tableNames
      .map((n) => renderTableSchemaTiered(byName.get(n)!))
      .join("\n\n");
  } else if (query) {
    // 探索式兜底：关键词检索
    const hits = searchTables(catalog, query, 3);
    tableNames = hits.map((h) => h.table.table.name);
    selected = hits.map((h) => renderTableSchemaTiered(h.table)).join("\n\n");
  } else {
    selected = "";
    tableNames = [];
  }

  const text = [skeleton, selected ? `\n--- 本次查询相关表 ---\n${selected}` : ""].join("\n");
  return {
    enabled: true,
    skeleton,
    selected,
    tableNames,
    estimatedTokens: estimateTokens(text),
  };
}

/** 简易 token 估算（与 schema-catalog render.estimateTokens 同构）。 */
function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const ascii = text.length - cjk;
  return Math.ceil(cjk * 1.1 + ascii / 4);
}
