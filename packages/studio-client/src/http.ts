export async function parseHttpError(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object" && "error" in body) {
      const error = body.error;
      if (typeof error === "string") return error;
      if (
        error &&
        typeof error === "object" &&
        "message" in error &&
        typeof error.message === "string"
      ) {
        return error.message;
      }
    }
  } catch {
    // 代理或服务器可能返回非 JSON 错误。
  }
  return `HTTP ${response.status}`;
}

/** transport 保留平台各自的地址、鉴权、workspace 头及中止信号处理。 */
export async function requestJson<T>(
  transport: (path: string, init?: RequestInit) => Promise<Response>,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await transport(path, init);
  if (!response.ok) throw new Error(await parseHttpError(response));
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
