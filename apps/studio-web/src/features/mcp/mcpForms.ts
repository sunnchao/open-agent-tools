import type { RemoteServiceConfigInput, RemoteTransport } from "./api.js";

export function coerceValue(value: string, type?: string): unknown {
  if (type === "number" || type === "integer") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`无法将 ${value} 转换为数字`);
    return parsed;
  }
  if (type === "boolean") {
    if (value !== "true" && value !== "false") throw new Error("布尔参数必须是 true 或 false");
    return value === "true";
  }
  if (type === "object" || type === "array") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      throw new Error(`${type === "object" ? "对象" : "数组"}参数必须是合法 JSON`);
    }
  }
  if (type === "null") return null;
  return value;
}

/** Parse request headers: an empty field is undefined; otherwise require string values. */
export function parseHeadersJson(text: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("请求头须为合法 JSON 对象");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("请求头须为 JSON 对象");
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string") throw new Error(`请求头 ${key} 的值须为字符串`);
    headers[key] = value;
  }
  return headers;
}

export function collectRemoteInput(values: Record<string, unknown>): RemoteServiceConfigInput {
  const headersText = String(values.headersText ?? "").trim();
  const token = String(values.token ?? "");
  return {
    transport: values.transport as RemoteTransport,
    url: String(values.url ?? "").trim(),
    timeoutMs: Number(values.timeoutMs ?? 30_000),
    ...(headersText === "" ? {} : { headers: parseHeadersJson(headersText) }),
    ...(token === "" ? {} : { token }),
  };
}
