/**
 * 轻量 trace 日志工具:统一输出格式、级别与敏感信息处理。
 * 不引入第三方依赖;所有 server 服务的请求与关键事件都走这里。
 * 格式:`[ISO时间] [trace:级别] 事件名 {"结构化详情"}`
 */

export type TraceLevel = "info" | "warn" | "error";

function format(level: TraceLevel, event: string, details?: Record<string, unknown>): void {
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
 * 截断过长字符串,避免把大段消息、参数或错误堆栈打进日志。
 * 非字符串原样返回;超过 maxChars 的部分只显示长度占位。
 */
export function truncate(value: unknown, maxChars = 200): unknown {
  if (typeof value !== "string") return value;
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…(+${value.length - maxChars} chars)`;
}

/** 脱敏:凭据类字符串只保留首尾少量字符,其余以 *** 遮蔽。 */
export function maskSecret(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}***${value.slice(-2)}`;
}
