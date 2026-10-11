import { createHash, randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { openDb } from "../db.js";
import { executeQuerySql } from "../function_tools/sqlQueryBuiltin.js";
import { getDefaultProvider, getProvider, type ProviderWithKey } from "../providers/store.js";
import { createLlmClient, type LlmClient } from "../providers/clients/index.js";
import { logDebug, logDebugDuration, logTrace, truncate } from "../trace.js";
import {
  buildDtmsSchemaPrompt,
  buildUnknownReplyText,
  isAllowedIndustry,
  resolvePageContext,
} from "../aiQuery/dtmsCatalog.js";
import { maskSensitiveRows } from "../aiQuery/sqlGuard.js";
import { rewriteAndValidateSqlWithAuth } from "../aiQuery/sqlRewrite.js";
import {
  PermissionError,
  assertQueryInScope,
  effectiveRowScope,
  resolvePermissionContext,
  type PermissionContext,
} from "../aiQuery/permission.js";
import { routeIntentWithGateA } from "../aiQuery/decisionProvider.js";

/**
 * AI 问数端点（POST /api/ai/query，标准 SSE）。
 *
 * 契约见 dtms-web `docs/AI问数接口契约.md` v2.1。
 * 业务范围仅限 DTMS：合同 / 发票 / 付款 / 收款 / 库存 / 清算；禁止 NEW-API 运营库。
 */

export const aiQueryRouter: ReturnType<typeof Router> = Router();

const INTENT_VERSION = "v1";
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
const LLM_CALL_TIMEOUT_MS = 30_000;
const SUMMARY_MAX_ROWS = 50;
const HISTORY_TURNS = 6;
const RESULT_LIMIT = 100;

/** 统一文案：错误码 → 用户可见 message（原始错误细节只进日志，见 PRD 4.4 第 6 条）。 */
const UNIFIED_TEXT = {
  INVALID_REQUEST: "请求参数有误",
  RATE_LIMITED: "提问太频繁，请稍后再试",
  AI_SERVICE_UNAVAILABLE: "AI 服务暂时不可用，请稍后再试",
  QUERY_BLOCKED: "暂不支持该查询",
  QUERY_TIMEOUT: "查询超时，请缩小时间范围后重试",
  QUERY_FAILED: "查询失败，请稍后重试或调整查询条件",
  PERMISSION_DENIED: "您暂无该数据范围的查询权限",
  SENSITIVE: "抱歉，该问题超出服务范围，请调整后重试。",
} as const;

const TRUNCATED_HINT = "仅展示前 100 条，可缩小范围或导出";

// ---------------------------------------------------------------------------
// 会话存储（SQLite，与 chat 的 sessions/messages 分表，避免混入聊天历史）
// ---------------------------------------------------------------------------

let storeReady = false;

function ensureAiQueryStore(): void {
  if (storeReady) return;
  openDb().exec(`
    CREATE TABLE IF NOT EXISTS ai_query_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      reply_type TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_query_messages_session
      ON ai_query_messages(session_id, created_at);
  `);
  storeReady = true;
}

function persistTurn(
  sessionId: string,
  role: "user" | "assistant",
  content: string,
  replyType?: string,
): void {
  try {
    ensureAiQueryStore();
    openDb()
      .prepare(
        `INSERT INTO ai_query_messages (id, session_id, role, content, reply_type, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `${sessionId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        sessionId,
        role,
        content,
        replyType ?? null,
        Date.now(),
      );
  } catch (error) {
    logTrace(
      "ai_query.persist",
      { sessionId, error: truncate(error instanceof Error ? error.message : String(error), 200) },
      "warn",
    );
  }
}

interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

function loadHistory(sessionId: string, limit = HISTORY_TURNS): HistoryTurn[] {
  try {
    ensureAiQueryStore();
    const rows = openDb()
      .prepare(
        `SELECT role, content FROM ai_query_messages
         WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(sessionId, limit) as Array<{ role: "user" | "assistant"; content: string }>;
    return rows.reverse();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 会话级限流：10 次/分钟（契约 2.3 / PRD 5.10）
// ---------------------------------------------------------------------------

const rateBuckets = new Map<string, number[]>();

export function checkRateLimit(sessionId: string): boolean {
  const now = Date.now();
  if (rateBuckets.size > 500) {
    for (const [key, hits] of rateBuckets) {
      const alive = hits.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
      if (alive.length === 0) rateBuckets.delete(key);
      else rateBuckets.set(key, alive);
    }
  }
  const hits = (rateBuckets.get(sessionId) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (hits.length >= RATE_LIMIT_MAX) {
    rateBuckets.set(sessionId, hits);
    return false;
  }
  hits.push(now);
  rateBuckets.set(sessionId, hits);
  return true;
}

/** 测试辅助：清空限流桶。 */
export function __resetRateLimiter(): void {
  rateBuckets.clear();
}

/** 会话存储与限流绑定登录用户；不把 userId 原文写入 SQLite 主键。 */
export function scopedSessionKey(userId: string, sessionId: string): string {
  return createHash("sha256").update(userId).update("\0").update(sessionId).digest("hex");
}

// ---------------------------------------------------------------------------
// 敏感词拦截（PRD 4.6）：命中不调 LLM、不落库，仅日志审计
// ---------------------------------------------------------------------------

const DEFAULT_SENSITIVE_WORDS = [
  "赌博",
  "博彩",
  "毒品",
  "贩毒",
  "色情",
  "淫秽",
  "恐怖袭击",
  "爆炸物",
  "枪支",
  "军火",
  "洗钱",
  "诈骗",
  "自杀",
  "自残",
  "邪教",
  "法轮",
  "黑客攻击",
  "ddos",
  "木马",
  "病毒",
  "假钞",
  "伪造证件",
  "代开发票",
  "买凶",
];

function sensitiveWords(): string[] {
  const extra = (process.env.AI_QUERY_SENSITIVE_WORDS ?? "")
    .split(",")
    .map((w) => w.trim())
    .filter(Boolean);
  return [...DEFAULT_SENSITIVE_WORDS, ...extra];
}

/** 匹配前小写化并去掉空白/常见分隔符，拦截「洗 钱」「色-情」类规避。 */
export function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[\s\-_.*·•、，,]+/g, "");
}

export function hitSensitiveWord(question: string): string | null {
  const normalized = normalizeForMatch(question);
  return sensitiveWords().find((word) => normalized.includes(normalizeForMatch(word))) ?? null;
}

// ---------------------------------------------------------------------------
// 意图识别：关键词快道（双信号高置信短路）+ LLM 兜底
// ---------------------------------------------------------------------------

const QUERY_SIGNALS =
  /(查询|查一下|查查|统计|合计|汇总|多少|多大|几条|几个|有多少|排名|前\s*\d+|top\s*\d+|占比|比例|趋势|平均|均值|总和|总额|总数|总量|最大|最小|最高|最低|环比|同比|对比)/i;
const DATA_SIGNALS =
  /(合同|发票|付款|收款|采购|开票|认票|客户|供应商|销售|回款|库存|清算|结算|报表|流水|金额|费用|成本|数量|吨|订单|资金)/i;
const CHAT_SIGNALS =
  /^(你好|您好|嗨|哈喽|在吗|谢谢|再见|早上好|晚上好|中午好|hello|hi|hey)[\s!！。.?？]*$/i;

/**
 * 快道判定：
 * - 纯问候/闲聊且无问数信号 → UNKNOWN（零 LLM）
 * - 查询意图 + DTMS 业务名词双信号 → DATA_QUERY
 * - 其余返回 null，交给 LLM 兜底
 */
export function fastIntent(question: string): "DATA_QUERY" | "UNKNOWN" | null {
  const trimmed = question.trim();
  if (CHAT_SIGNALS.test(trimmed) && !QUERY_SIGNALS.test(trimmed) && !DATA_SIGNALS.test(trimmed)) {
    return "UNKNOWN";
  }
  return QUERY_SIGNALS.test(trimmed) && DATA_SIGNALS.test(trimmed) ? "DATA_QUERY" : null;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new Error("请求已取消");
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`LLM 调用超时（${ms}ms）`)), ms);
    timer.unref();
  });
  const onAbort = (): void => {
    clearTimeout(timer);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([
      promise,
      timeout,
      ...(signal
        ? [
            new Promise<never>((_, reject) => {
              signal.addEventListener("abort", () => reject(new Error("请求已取消")), {
                once: true,
              });
            }),
          ]
        : []),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function classifyIntentWithLlm(
  llm: LlmClient,
  model: string,
  question: string,
  pageContext: string | undefined,
  signal?: AbortSignal,
): Promise<"DATA_QUERY" | "UNKNOWN"> {
  const system =
    "你是 DTMS（湖北国贸供应链协同管理平台）意图分类器。\n" +
    "只判断用户是否在查询 DTMS 业务数据（合同、发票、付款、收款、库存、清算）。\n" +
    '只输出 JSON，不要解释：{"intentType":"DATA_QUERY"} 或 {"intentType":"UNKNOWN"}。\n' +
    "DATA_QUERY：查数量/金额/排名/趋势/明细等 DTMS 业务数据；\n" +
    "UNKNOWN：闲聊、创作、翻译、写代码、NEW-API/运营平台（token/quota/模型调用量）及其它与 DTMS 无关的请求。";
  const user = pageContext ? `当前页面：${pageContext}\n问题：${question}` : question;
  const resp = await withTimeout(
    llm.complete({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      signal,
    }),
    LLM_CALL_TIMEOUT_MS,
    signal,
  );
  const parsed = extractJson(resp.content);
  return parsed?.intentType === "DATA_QUERY" ? "DATA_QUERY" : "UNKNOWN";
}

// ---------------------------------------------------------------------------
// text2sql：LLM 生成 SQL（含多轮上下文与 DTMS schema）
// ---------------------------------------------------------------------------

interface SqlGenResult {
  sql?: string;
  clarifyingQuestion?: string;
}

async function generateSql(
  llm: LlmClient,
  model: string,
  question: string,
  history: HistoryTurn[],
  industry: string | undefined,
  pageContext: string | undefined,
  allowedModules: PermissionContext["modules"] | undefined,
  signal?: AbortSignal,
): Promise<SqlGenResult> {
  const schema = buildDtmsSchemaPrompt(question, pageContext, allowedModules);
  const historyText = history
    .map((turn) => `${turn.role === "user" ? "用户" : "助手"}: ${turn.content}`)
    .join("\n");
  const pageHint = resolvePageContext(pageContext);

  const system =
    "你是 DTMS（湖北国贸供应链协同管理平台）的 text2sql 助手，把用户问题转成一条只读 SELECT。\n" +
    "业务范围仅限用户有权限的模块表（见下方白名单）。\n" +
    "禁止查询 NEW-API / 运营平台数据（users、logs、tokens、quota、models、channels 等）。\n" +
    "规则：\n" +
    "1) 表名/列名必须来自下方白名单，用反引号；日期字段是 DATE，按自然日过滤，不要用 Unix 秒；\n" +
    "2) 只输出单条 SELECT；聚合列必须用中文别名（如 SELECT SUM(total_amount) AS `合同金额合计`）；\n" +
    "3) 明细默认 ORDER BY 业务日期 DESC，不要自己写 LIMIT（执行器会截断）；\n" +
    "4) 缺少必要口径（时间范围）且上下文也推不出 → 追问，不要猜默认值；一次只追问一个参数；\n" +
    "5) 不要写 industry / org_no 权限条件，执行器会强制注入；不要 UNION。\n" +
    (industry ? `6) 业务口径按「${industry}」理解（仍不要在 SQL 里写权限过滤）。\n` : "") +
    (pageHint.module ? `7) 当前页面属于「${pageHint.module}」模块，优先用对应表。\n` : "") +
    "\n只输出 JSON，不要解释：\n" +
    '能写 SQL → {"sql":"SELECT ..."}\n' +
    '缺少必要口径 → {"clarifying":"请问要查询哪个时间范围？"}';
  const user =
    (historyText ? `最近对话（用于解析指代，如"那 3 月呢"）：\n${historyText}\n\n` : "") +
    (pageContext ? `当前页面：${pageContext}\n` : "") +
    `${schema}\n\n本次问题：${question}`;

  const resp = await withTimeout(
    llm.complete({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      signal,
    }),
    LLM_CALL_TIMEOUT_MS,
    signal,
  );
  const parsed = extractJson(resp.content);
  if (!parsed) return {};
  return {
    sql: typeof parsed.sql === "string" && parsed.sql.trim() ? parsed.sql.trim() : undefined,
    clarifyingQuestion:
      typeof parsed.clarifying === "string" && parsed.clarifying.trim()
        ? parsed.clarifying.trim()
        : undefined,
  };
}

/** 从 LLM 输出里稳健地抠出 JSON（容忍 markdown 代码围栏与前后文本）。 */
export function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** SQL 执行错误 → 契约错误码（超时类单独映射，见 PRD 5.6）。 */
export function mapSqlError(message: string): "QUERY_TIMEOUT" | "QUERY_FAILED" {
  return /timeout|timed out|etimedout|econnreset/i.test(message) ? "QUERY_TIMEOUT" : "QUERY_FAILED";
}

export function buildScopeText(industry?: string, pageContext?: string): string {
  const parts: string[] = [];
  if (industry) parts.push(`行业：${industry}`);
  const hint = resolvePageContext(pageContext);
  if (hint.module) parts.push(`模块：${hint.module}`);
  return parts.join("；");
}

export function emptyResultText(industry?: string, pageContext?: string): string {
  const scope = buildScopeText(industry, pageContext);
  return scope
    ? `未查询到符合条件的数据（${scope}），请调整时间范围或筛选条件后重试。`
    : "未查询到符合条件的数据，请调整时间范围或筛选条件后重试。";
}

// ---------------------------------------------------------------------------
// 结果 → data 载荷（契约 3）
// ---------------------------------------------------------------------------

export interface MetricData {
  type: "metric";
  value: number | string;
  unit?: string;
  label: string;
  scope?: string;
}

export interface TableData {
  type: "table";
  columns: Array<{ key: string; title: string }>;
  rows: Array<Record<string, string | number | null>>;
  totalRows: number;
  truncated: boolean;
}

function isNumeric(v: unknown): boolean {
  return typeof v === "number"
    ? Number.isFinite(v)
    : typeof v === "string" && v !== "" && Number.isFinite(Number(v));
}

function guessUnit(label: string): string | undefined {
  if (/金额|费用|成本|价格|收入|支出|销售额|额度/.test(label)) return "元";
  if (/率|比例|占比/.test(label)) return "%";
  return undefined;
}

/** 行数组 → metric（单行单数值列）或 table（其余）。rows 已由执行器截断到 100，调用方保证非空。 */
export function buildDataPayload(
  rows: Record<string, unknown>[],
  industry?: string,
  pageContext?: string,
): MetricData | TableData {
  const first = rows[0];
  if (!first) throw new Error("buildDataPayload 需要至少一行数据");
  const columns = Object.keys(first);
  const label = columns[0];
  const scope = buildScopeText(industry, pageContext);
  if (rows.length === 1 && label !== undefined && columns.length === 1 && isNumeric(first[label])) {
    const raw = first[label];
    const value: number | string = typeof raw === "number" ? raw : (raw as string);
    const unit = guessUnit(label);
    return {
      type: "metric",
      value,
      label,
      ...(unit ? { unit } : {}),
      ...(scope ? { scope } : {}),
    };
  }
  return {
    type: "table",
    columns: columns.map((key) => ({ key, title: key })),
    rows: rows.map((row) => {
      const normalized: Record<string, string | number | null> = {};
      for (const key of columns) {
        const v = row[key];
        normalized[key] = v === null || v === undefined ? null : (v as string | number);
      }
      return normalized;
    }),
    totalRows: rows.length,
    truncated: rows.length >= RESULT_LIMIT,
  };
}

// ---------------------------------------------------------------------------
// SSE 端点
// ---------------------------------------------------------------------------

interface AiQueryRequestBody {
  sessionId?: string;
  question?: string;
  pageContext?: string;
  industry?: string;
}

/** 请求级错误（SSE 前）：普通 JSON + HTTP 状态码，不是事件流。 */
function rejectRequest(
  res: Response,
  status: 400 | 429,
  code: "INVALID_REQUEST" | "RATE_LIMITED",
  error: string,
): void {
  res.status(status).json({
    code,
    replyType: "error",
    replyText: UNIFIED_TEXT[code],
    error,
    meta: {},
  });
}

aiQueryRouter.post("/api/ai/query", async (req: Request, res: Response) => {
  const startedAt = Date.now();
  const traceId = randomUUID();
  const { sessionId, question, pageContext, industry } = (req.body ?? {}) as AiQueryRequestBody;

  if (typeof sessionId !== "string" || sessionId.trim().length === 0 || sessionId.length > 64) {
    rejectRequest(res, 400, "INVALID_REQUEST", "sessionId 必填且长度 ≤ 64");
    return;
  }
  if (typeof question !== "string" || question.trim().length < 1 || question.trim().length > 300) {
    rejectRequest(res, 400, "INVALID_REQUEST", "question 必填，trim 后 1~300 字符");
    return;
  }
  if (pageContext !== undefined && (typeof pageContext !== "string" || pageContext.length > 200)) {
    rejectRequest(res, 400, "INVALID_REQUEST", "pageContext 长度 ≤ 200");
    return;
  }
  if (industry !== undefined && (typeof industry !== "string" || industry.length > 100)) {
    rejectRequest(res, 400, "INVALID_REQUEST", "industry 长度 ≤ 100");
    return;
  }
  const trimmedQuestion = question.trim();
  const trimmedPageContext =
    typeof pageContext === "string" && pageContext.trim() ? pageContext.trim() : undefined;
  const pageHint = resolvePageContext(trimmedPageContext);
  const sid = sessionId.trim();

  const permissionStartedAt = Date.now();
  let perm: PermissionContext;
  try {
    perm = await resolvePermissionContext(req);
    assertQueryInScope(trimmedQuestion, trimmedPageContext, perm);
    logDebugDuration("ai_query.stage.permission", permissionStartedAt, {
      traceId,
      industries: perm.industries.length,
      modules: perm.modules.length,
    });
  } catch (error) {
    if (error instanceof PermissionError) {
      res.status(200);
      // 契约：越权走 SSE error 事件；鉴权失败（无 token/中台不可用）同样用统一权限话术，避免泄露。
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(
        `event: error\ndata: ${JSON.stringify({ code: "PERMISSION_DENIED", message: UNIFIED_TEXT.PERMISSION_DENIED })}\n\n`,
      );
      res.write(
        `event: done\ndata: ${JSON.stringify({ code: "PERMISSION_DENIED", sessionId: sid, meta: { clarifying: false, durationMs: Date.now() - startedAt } })}\n\n`,
      );
      res.end();
      return;
    }
    throw error;
  }
  const sessionKey = scopedSessionKey(perm.userId, sid);
  if (!checkRateLimit(sessionKey)) {
    logTrace("ai_query.rejected", { sessionId: sid, reason: "rate limited" }, "warn");
    rejectRequest(res, 429, "RATE_LIMITED", `${RATE_LIMIT_MAX} 次/分钟`);
    return;
  }
  const rowScope = effectiveRowScope(perm);
  const bodyIndustryRaw = typeof industry === "string" ? industry.trim() : "";
  const bodyIndustry = isAllowedIndustry(bodyIndustryRaw) ? bodyIndustryRaw : undefined;
  if (bodyIndustry && !perm.industries.includes(bodyIndustry)) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(
      `event: error\ndata: ${JSON.stringify({ code: "PERMISSION_DENIED", message: UNIFIED_TEXT.PERMISSION_DENIED })}\n\n`,
    );
    res.write(
      `event: done\ndata: ${JSON.stringify({ code: "PERMISSION_DENIED", sessionId: sid, meta: { clarifying: false, durationMs: Date.now() - startedAt } })}\n\n`,
    );
    res.end();
    return;
  }
  const trimmedIndustry =
    rowScope.industries.length === 1
      ? rowScope.industries[0]
      : pageHint.industry && perm.industries.includes(pageHint.industry)
        ? pageHint.industry
        : perm.currentIndustry;

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  let finished = false;
  let intentMeta: {
    via?: "rule" | "decision" | "llm" | "blocked";
    decisionMs?: number;
    confidence?: number;
    gates?: string[];
  } = {};
  const abort = new AbortController();
  res.on("close", () => {
    if (!finished) abort.abort();
  });

  const sendEvent = (event: string, data: Record<string, unknown>): void => {
    if (abort.signal.aborted || finished) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const heartbeat = setInterval(() => {
    if (!abort.signal.aborted && !finished) res.write(": ping\n\n");
  }, 15_000);
  heartbeat.unref();

  const finish = (code: string, meta: { clarifying: boolean; blocked?: boolean }): void => {
    if (finished) return;
    finished = true;
    clearInterval(heartbeat);
    if (!abort.signal.aborted) {
      res.write(
        `event: done\ndata: ${JSON.stringify({
          code,
          sessionId: sid,
          meta: { ...meta, ...intentMeta, durationMs: Date.now() - startedAt },
        })}\n\n`,
      );
      res.end();
    }
  };

  const failWith = (code: keyof typeof UNIFIED_TEXT): void => {
    logTrace(
      "ai_query.error",
      { sessionId: sid, code, durationMs: Date.now() - startedAt },
      "error",
    );
    sendEvent("error", { code, message: UNIFIED_TEXT[code] });
    finish(code, { clarifying: false });
  };

  const persistSuccess = (replyText: string, replyType: string): void => {
    if (abort.signal.aborted) return;
    persistTurn(sessionKey, "user", trimmedQuestion);
    persistTurn(sessionKey, "assistant", replyText, replyType);
  };

  logTrace("ai_query.start", {
    traceId,
    sessionId: sid,
    questionLength: trimmedQuestion.length,
    pageContext: trimmedPageContext ?? null,
  });

  const sensitive = hitSensitiveWord(trimmedQuestion);
  if (sensitive) {
    intentMeta = { via: "blocked" };
    logTrace(
      "ai_query.blocked",
      { sessionId: sid, hit: sensitive, durationMs: Date.now() - startedAt },
      "warn",
    );
    sendEvent("intent", { sessionId: sid, intentType: "UNKNOWN", intentVersion: INTENT_VERSION });
    sendEvent("reply", {
      sessionId: sid,
      replyType: "text",
      replyText: UNIFIED_TEXT.SENSITIVE,
      clarifying: false,
    });
    finish("OK", { clarifying: false, blocked: true });
    return;
  }

  void (async () => {
    try {
      const providerId = process.env.AI_QUERY_PROVIDER_ID;
      const provider: ProviderWithKey | null = providerId
        ? getProvider(providerId, { requireEnabled: true })
        : getDefaultProvider({ requireEnabled: true });
      if (!provider) {
        failWith("AI_SERVICE_UNAVAILABLE");
        return;
      }
      const llm = createLlmClient({ ...provider, apiKey: provider.apiKey ?? "ollama" });
      const model = process.env.AI_QUERY_MODEL || provider.models[0] || "gpt-4o-mini";
      const history = loadHistory(sessionKey);
      const signal = abort.signal;

      const intentStartedAt = Date.now();
      const fast = fastIntent(trimmedQuestion);
      let intentType: "DATA_QUERY" | "UNKNOWN";
      if (fast) {
        intentType = fast;
        intentMeta = { via: "rule" };
      } else {
        const routed = await routeIntentWithGateA(
          {
            traceId,
            question: trimmedQuestion,
            pageContext: trimmedPageContext,
            industry: trimmedIndustry,
            hasSessionHistory: history.length > 0,
            signal,
          },
          () => classifyIntentWithLlm(llm, model, trimmedQuestion, trimmedPageContext, signal),
        );
        intentType = routed.intent;
        intentMeta = {
          via: routed.via,
          ...(routed.decisionMs === undefined ? {} : { decisionMs: routed.decisionMs }),
          ...(routed.confidence === undefined ? {} : { confidence: routed.confidence }),
          ...(routed.gates ? { gates: routed.gates } : {}),
        };
      }
      logDebugDuration("ai_query.stage.intent", intentStartedAt, {
        traceId,
        intentType,
        ...intentMeta,
      });
      sendEvent("intent", { sessionId: sid, intentType, intentVersion: INTENT_VERSION });

      if (intentType === "UNKNOWN") {
        const replyText = buildUnknownReplyText(trimmedIndustry, perm.modules);
        persistSuccess(replyText, "text");
        sendEvent("reply", {
          sessionId: sid,
          replyType: "text",
          replyText,
          clarifying: false,
        });
        finish("OK", { clarifying: false });
        return;
      }

      const generateSqlStartedAt = Date.now();
      const gen = await generateSql(
        llm,
        model,
        trimmedQuestion,
        history,
        trimmedIndustry,
        trimmedPageContext,
        perm.modules,
        signal,
      );
      logDebugDuration("ai_query.stage.generate_sql", generateSqlStartedAt, {
        traceId,
        hasSql: Boolean(gen.sql),
        clarifying: Boolean(gen.clarifyingQuestion),
      });
      if (abort.signal.aborted) return;
      if (gen.clarifyingQuestion) {
        persistSuccess(gen.clarifyingQuestion, "text");
        sendEvent("reply", {
          sessionId: sid,
          replyType: "text",
          replyText: gen.clarifyingQuestion,
          clarifying: true,
        });
        finish("OK", { clarifying: true });
        return;
      }
      if (!gen.sql) {
        failWith("QUERY_BLOCKED");
        return;
      }

      let rewritten: ReturnType<typeof rewriteAndValidateSqlWithAuth>;
      try {
        rewritten = rewriteAndValidateSqlWithAuth(
          gen.sql,
          rowScope.industries,
          rowScope.orgNos,
          perm.modules,
        );
      } catch (error) {
        logTrace(
          "ai_query.guard",
          {
            sessionId: sid,
            reason: truncate(error instanceof Error ? error.message : String(error), 200),
            sql: truncate(gen.sql, 200),
          },
          "warn",
        );
        failWith(error instanceof PermissionError ? "PERMISSION_DENIED" : "QUERY_BLOCKED");
        return;
      }
      const executed = await executeQuerySql(rewritten.sql, rewritten.params);
      logDebug("ai_query.stage.execute_sql", {
        traceId,
        ok: executed.ok,
        rows: executed.rows?.length ?? 0,
        durationMs: executed.durationMs,
        ...(executed.error ? { error: truncate(executed.error, 200) } : {}),
      });
      if (abort.signal.aborted) return;
      if (!executed.ok) {
        failWith(mapSqlError(executed.error ?? ""));
        return;
      }
      const rows = maskSensitiveRows((executed.rows ?? []) as Record<string, unknown>[]);
      if (rows.length === 0) {
        const replyText = emptyResultText(trimmedIndustry, trimmedPageContext);
        persistSuccess(replyText, "text");
        sendEvent("reply", {
          sessionId: sid,
          replyType: "text",
          replyText,
          clarifying: false,
        });
        finish("OK", { clarifying: false });
        return;
      }

      const data = buildDataPayload(rows, trimmedIndustry, trimmedPageContext);

      const summaryStartedAt = Date.now();
      const summary = await llm.streamChat({
        model,
        signal,
        messages: [
          {
            role: "system",
            content:
              "你是 DTMS 数据分析助手。基于查询结果用中文回答，2~4 句：先直接给出结论（金额用千分位、两位小数），再补充口径（时间范围、行业、模块）。不要编造数据，不要输出 SQL，不要输出 markdown，不要提及 NEW-API。",
          },
          {
            role: "user",
            content: `用户问题：${trimmedQuestion}\n\n查询结果（JSON）：${JSON.stringify(
              data.type === "metric"
                ? { ...data }
                : { ...data, rows: data.rows.slice(0, SUMMARY_MAX_ROWS) },
            )}`,
          },
        ],
        callbacks: {
          onDelta: (delta: string) => {
            sendEvent("delta", { text: delta });
          },
        },
      });
      logDebugDuration("ai_query.stage.summary", summaryStartedAt, {
        traceId,
        replyType: data.type,
        contentLength: summary.content.length,
      });
      if (abort.signal.aborted) return;

      const replyText =
        data.type === "table" && data.truncated
          ? `${summary.content.trim()}\n${TRUNCATED_HINT}`
          : summary.content;
      persistSuccess(replyText, data.type);
      sendEvent("reply", {
        sessionId: sid,
        replyType: data.type,
        replyText,
        data,
        clarifying: false,
      });
      logTrace("ai_query.done", {
        sessionId: sid,
        replyType: data.type,
        rows: rows.length,
        durationMs: Date.now() - startedAt,
      });
      finish("OK", { clarifying: false });
    } catch (error) {
      if (abort.signal.aborted) return;
      logTrace(
        "ai_query.llm_error",
        {
          sessionId: sid,
          error: truncate(error instanceof Error ? error.message : String(error), 300),
          durationMs: Date.now() - startedAt,
        },
        "error",
      );
      failWith("AI_SERVICE_UNAVAILABLE");
    }
  })();
});
