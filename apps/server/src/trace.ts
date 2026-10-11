/**
 * 轻量 trace 日志工具:统一输出格式、级别与敏感信息处理。
 * 不引入第三方依赖;所有 server 服务的请求与关键事件都走这里。
 * 格式:`[ISO时间] [trace:级别] 事件名 {"结构化详情"}`
 *
 * Debug 模式(环境变量 `DEBUG=true`/`DEBUG=1`):
 * - 打开 "debug" 级别日志。该级别默认静默,用于各阶段耗时等高频细节,避免生产环境刷屏;
 * - `truncate()` / `maskSecret()` 不再截断或脱敏,直接返回原始值,方便本地排查完整 SQL/Prompt/凭据。
 *   仅限本地开发使用,生产环境不要打开 DEBUG。
 */

export type TraceLevel = "debug" | "info" | "warn" | "error";

/** DEBUG=true 或 DEBUG=1 时开启调试模式;每次读取 process.env,方便测试里动态切换。 */
export function isDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.DEBUG?.trim().toLowerCase();
  return raw === "true" || raw === "1";
}

function format(level: TraceLevel, event: string, details?: Record<string, unknown>): void {
  if (level === "debug" && !isDebugEnabled()) return;
  const line = `[${new Date().toISOString()}] [trace:${level}] ${event}`;
  if (details && Object.keys(details).length > 0) {
    console.log(line, JSON.stringify(details));
  } else {
    console.log(line);
  }
}

/** 记录一条 trace 事件。details 必须是可 JSON 序列化的纯数据。 */
export function logTrace(
  event: string,
  details?: Record<string, unknown>,
  level: TraceLevel = "info",
): void {
  format(level, event, details);
}

/** 记录一段操作的耗时:startedAt 为操作开始时的 Date.now() 毫秒时间戳。 */
export function logDuration(
  event: string,
  startedAt: number,
  details?: Record<string, unknown>,
  level: TraceLevel = "info",
): void {
  format(level, event, { ...details, durationMs: Date.now() - startedAt });
}

/**
 * debug 级别便捷方法:语义等价于 `logTrace(event, details, "debug")`。
 * 仅在 DEBUG=true 时输出,用于不需要计时的调试细节(如缓存命中、上游返回体结构)。
 */
export function logDebug(event: string, details?: Record<string, unknown>): void {
  format("debug", event, details);
}

/**
 * debug 级别耗时便捷方法:语义等价于 `logDuration(event, startedAt, details, "debug")`。
 * 用于给各阶段(权限解析、LLM 调用、SQL 生成/执行等)补充细粒度耗时,仅在 DEBUG=true 时输出。
 */
export function logDebugDuration(
  event: string,
  startedAt: number,
  details?: Record<string, unknown>,
): void {
  format("debug", event, { ...details, durationMs: Date.now() - startedAt });
}

/**
 * 截断过长字符串,避免把大段消息、参数或错误堆栈打进日志。
 * DEBUG=true 时不截断,原样返回完整内容,便于本地排查。
 * 非字符串原样返回;超过 maxChars 的部分只显示长度占位。
 */
export function truncate(value: unknown, maxChars = 200): unknown {
  if (typeof value !== "string") return value;
  if (isDebugEnabled()) return value;
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…(+${value.length - maxChars} chars)`;
}

/**
 * 脱敏:凭据类字符串只保留首尾少量字符,其余以 *** 遮蔽。
 * DEBUG=true 时不脱敏,直接返回原值——仅限本地开发排查凭据类问题,生产环境不要打开 DEBUG。
 */
export function maskSecret(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (isDebugEnabled()) return value;
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}***${value.slice(-2)}`;
}
