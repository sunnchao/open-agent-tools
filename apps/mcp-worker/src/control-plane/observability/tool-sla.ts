import type { AuditEventRecord } from "../audit-repository.js";
import { ManagementError } from "../management.js";
import { percentile } from "./audit-stats.js";

/**
 * 工具 SLA 聚合:只读取既有 mcp_audit_events(每次 Gateway MCP 请求都会落库),
 * 按「服务 slug + 工具名」汇总成功率、时延分位与错误 Top N。
 *
 * 说明:当前实现复用 audit 仓储的单条读取(list + get),未新增数据库迁移;
 * 事件量大时建议为 mcp_audit_events(source, action, created_at) 增加联合索引,
 * 并把按工具维度的聚合下推到 SQL(此处仅在注释中说明,不改动 drizzle 迁移)。
 */

/** SLA 面板支持的统计窗口。 */
export type SlaWindow = "24h" | "7d";

export const SLA_WINDOW_MS: Record<SlaWindow, number> = {
  "24h": 24 * 60 * 60 * 1_000,
  "7d": 7 * 24 * 60 * 60 * 1_000,
};

/** 只统计 Gateway 的工具调用审计(action 形如 `MCP tools/call`)。 */
export const TOOL_CALL_ACTION = "MCP tools/call";

/** 归一化错误消息的最大长度,避免回显超长审计输出。 */
const MAX_ERROR_MESSAGE_LENGTH = 200;

/** 校验并归一化窗口参数;非法值抛出 VALIDATION_ERROR(HTTP 400)。 */
export function resolveSlaWindow(value: unknown): SlaWindow {
  if (value === undefined || value === null || value === "") return "24h";
  if (value === "24h" || value === "7d") return value;
  throw new ManagementError(
    "VALIDATION_ERROR",
    `window must be one of 24h|7d, received: ${String(value)}`,
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface ToolCallIdentity {
  serviceSlug: string;
  toolName: string;
}

function slugFromTarget(target: string): string {
  const match = /\/mcp\/services\/([^/?#]+)/.exec(target);
  if (!match?.[1]) return "";
  try {
    return decodeURIComponent(match[1]).trim();
  } catch {
    return match[1].trim();
  }
}

/**
 * 从审计事件中提取「服务 slug + 工具名」。
 * 仅 Gateway 的 tools/call 事件可解析;其余事件返回 null,不参与 SLA 聚合。
 */
export function extractToolCall(event: AuditEventRecord): ToolCallIdentity | null {
  if (event.source !== "gateway") return null;
  const input = asRecord(event.input);
  if (!input || input.method !== "tools/call") return null;
  const params = asRecord(input.params);
  const toolName = typeof params?.name === "string" ? params.name.trim() : "";
  if (!toolName) return null;
  const context = asRecord(event.context);
  const contextSlug = typeof context?.serviceSlug === "string" ? context.serviceSlug.trim() : "";
  const serviceSlug = contextSlug || slugFromTarget(event.target);
  if (!serviceSlug) return null;
  return { serviceSlug, toolName };
}

/**
 * 归一化错误消息:折叠空白、抹掉密钥/摘要/请求 ID 等高基数片段,
 * 让同一种失败在聚合时落到同一个桶里,同时避免回显敏感内容。
 */
export function normalizeErrorMessage(value: unknown): string {
  if (typeof value !== "string") return "";
  let text = value.replace(/\s+/g, " ").trim();
  if (!text) return "";
  text = text
    .replace(/\bmcp\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/sha256:[0-9a-f]{16,}/gi, "sha256:<digest>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\b[0-9a-f]{32,}\b/gi, "<digest>")
    .replace(/requestId:\s*[A-Za-z0-9._:-]+/gi, "requestId: <id>");
  return text.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${text.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)}…`
    : text;
}

function firstTextContent(output: Record<string, unknown> | null): string {
  const content = asRecord(output?.result)?.content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    const entry = asRecord(item);
    if (entry && typeof entry.text === "string") parts.push(entry.text);
  }
  return parts.join(" ");
}

/**
 * 从审计输出中归类失败原因,只使用 output/statusCode,绝不回显入参。
 * 优先级:JSON-RPC error > Tool isError 结果 > HTTP 错误 > 兜底。
 */
export function classifyToolError(event: AuditEventRecord): { code: string; message: string } {
  const output = asRecord(event.output);
  const rpcError = asRecord(output?.error);
  if (rpcError) {
    const rawCode = rpcError.code;
    const code =
      typeof rawCode === "number"
        ? `JSONRPC_${rawCode}`
        : typeof rawCode === "string" && rawCode.trim()
          ? rawCode.trim().toUpperCase()
          : `HTTP_${event.statusCode}`;
    return { code, message: normalizeErrorMessage(rpcError.message) || code };
  }
  if (asRecord(output?.result)?.isError === true) {
    return {
      code: "TOOL_ERROR",
      message: normalizeErrorMessage(firstTextContent(output)) || "Tool reported an error",
    };
  }
  if (event.statusCode >= 400) {
    return { code: `HTTP_${event.statusCode}`, message: `HTTP ${event.statusCode}` };
  }
  return { code: "FAILED", message: "Unclassified failure" };
}

export interface SlaErrorBucket {
  code: string;
  message: string;
  count: number;
}

export interface ToolSlaLastFailure {
  code: string;
  message: string;
  statusCode: number;
  createdAt: string;
}

export interface ToolSlaStat {
  toolName: string;
  calls: number;
  succeeded: number;
  failed: number;
  /** 成功率 0~1;窗口内无调用时为 0。 */
  successRate: number;
  p50DurationMs: number;
  p95DurationMs: number;
  maxDurationMs: number;
  /** 错误码 + 归一化消息聚合后的 Top N。 */
  errors: SlaErrorBucket[];
  /** 最近一次失败原因;窗口内无失败时为 null。 */
  lastFailure: ToolSlaLastFailure | null;
}

export interface ServiceSlaStat {
  serviceSlug: string;
  calls: number;
  succeeded: number;
  failed: number;
  successRate: number;
  p95DurationMs: number;
  tools: ToolSlaStat[];
}

export interface ToolSlaScanInfo {
  /** 实际扫描到的审事件条数(可能被 scanLimit 截断)。 */
  events: number;
  limit: number;
  /** 达到扫描上限时为 true,说明较早的工具调用未被纳入统计。 */
  truncated: boolean;
}

export interface ToolSlaReport {
  window: SlaWindow;
  windowMinutes: number;
  generatedAt: string;
  /** 过滤的服务 slug;未过滤时为 null。 */
  serviceSlug: string | null;
  scan: ToolSlaScanInfo;
  totals: {
    calls: number;
    succeeded: number;
    failed: number;
    successRate: number;
    p95DurationMs: number;
  };
  services: ServiceSlaStat[];
}

export interface ToolSlaOptions {
  window?: SlaWindow;
  now?: Date;
  serviceSlug?: string | null;
  topErrors?: number;
  /** 扫描上限,用于标记 scan.truncated。 */
  scanLimit?: number;
}

interface ToolAccumulator {
  durations: number[];
  succeeded: number;
  failed: number;
  errors: Map<string, SlaErrorBucket>;
  lastFailure: ToolSlaLastFailure | null;
}

function accumulateError(accumulator: ToolAccumulator, event: AuditEventRecord): void {
  const { code, message } = classifyToolError(event);
  const key = `${code}\u0000${message}`;
  const bucket = accumulator.errors.get(key) ?? { code, message, count: 0 };
  bucket.count += 1;
  accumulator.errors.set(key, bucket);
  if (!accumulator.lastFailure || event.createdAt > accumulator.lastFailure.createdAt) {
    accumulator.lastFailure = {
      code,
      message,
      statusCode: event.statusCode,
      createdAt: event.createdAt,
    };
  }
}

function successRate(succeeded: number, total: number): number {
  return total === 0 ? 0 : round(succeeded / total);
}

/** 汇总工具 SLA:成功/失败计数、成功率、P50/P95、错误 Top N 与最近失败原因。 */
export function summarizeToolSla(
  events: AuditEventRecord[],
  options: ToolSlaOptions = {},
): ToolSlaReport {
  const window = options.window ?? "24h";
  const windowMs = SLA_WINDOW_MS[window];
  const now = options.now ?? new Date();
  const cutoff = now.getTime() - windowMs;
  const topErrors = options.topErrors ?? 5;
  const scanLimit = options.scanLimit ?? events.length;
  const serviceFilter = options.serviceSlug?.trim() ? options.serviceSlug.trim() : null;

  const byService = new Map<string, Map<string, ToolAccumulator>>();
  const serviceDurations = new Map<string, number[]>();
  const totals = { durations: [] as number[], succeeded: 0, failed: 0 };

  for (const event of events) {
    const at = Date.parse(event.createdAt);
    if (Number.isFinite(at) && at < cutoff) continue;
    const identity = extractToolCall(event);
    if (!identity) continue;
    if (serviceFilter && identity.serviceSlug !== serviceFilter) continue;

    const duration = Math.max(0, event.durationMs);
    const succeeded = event.outcome === "SUCCEEDED";
    totals.durations.push(duration);
    if (succeeded) totals.succeeded += 1;
    else totals.failed += 1;

    let tools = byService.get(identity.serviceSlug);
    if (!tools) {
      tools = new Map<string, ToolAccumulator>();
      byService.set(identity.serviceSlug, tools);
      serviceDurations.set(identity.serviceSlug, []);
    }
    serviceDurations.get(identity.serviceSlug)!.push(duration);

    const accumulator = tools.get(identity.toolName) ?? {
      durations: [],
      succeeded: 0,
      failed: 0,
      errors: new Map<string, SlaErrorBucket>(),
      lastFailure: null,
    };
    accumulator.durations.push(duration);
    if (succeeded) accumulator.succeeded += 1;
    else {
      accumulator.failed += 1;
      accumulateError(accumulator, event);
    }
    tools.set(identity.toolName, accumulator);
  }

  const services: ServiceSlaStat[] = [...byService.entries()]
    .map(([serviceSlug, tools]) => {
      let succeeded = 0;
      let failed = 0;
      const stats: ToolSlaStat[] = [...tools.entries()]
        .map(([toolName, accumulator]) => {
          succeeded += accumulator.succeeded;
          failed += accumulator.failed;
          const calls = accumulator.succeeded + accumulator.failed;
          return {
            toolName,
            calls,
            succeeded: accumulator.succeeded,
            failed: accumulator.failed,
            successRate: successRate(accumulator.succeeded, calls),
            p50DurationMs: round(percentile(accumulator.durations, 0.5)),
            p95DurationMs: round(percentile(accumulator.durations, 0.95)),
            maxDurationMs:
              accumulator.durations.length === 0 ? 0 : Math.max(...accumulator.durations),
            errors: [...accumulator.errors.values()]
              .sort(
                (left, right) => right.count - left.count || left.code.localeCompare(right.code),
              )
              .slice(0, topErrors),
            lastFailure: accumulator.lastFailure,
          };
        })
        .sort(
          (left, right) => right.calls - left.calls || left.toolName.localeCompare(right.toolName),
        );
      const calls = succeeded + failed;
      return {
        serviceSlug,
        calls,
        succeeded,
        failed,
        successRate: successRate(succeeded, calls),
        p95DurationMs: round(percentile(serviceDurations.get(serviceSlug) ?? [], 0.95)),
        tools: stats,
      };
    })
    .sort(
      (left, right) =>
        right.calls - left.calls || left.serviceSlug.localeCompare(right.serviceSlug),
    );

  const totalCalls = totals.succeeded + totals.failed;
  return {
    window,
    windowMinutes: Math.round(windowMs / 60_000),
    generatedAt: now.toISOString(),
    serviceSlug: serviceFilter,
    scan: {
      events: events.length,
      limit: scanLimit,
      truncated: scanLimit > 0 && events.length >= scanLimit,
    },
    totals: {
      calls: totalCalls,
      succeeded: totals.succeeded,
      failed: totals.failed,
      successRate: successRate(totals.succeeded, totalCalls),
      p95DurationMs: round(percentile(totals.durations, 0.95)),
    },
    services,
  };
}
