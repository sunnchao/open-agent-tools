/** JSON SSE 分帧；尾部半包保留给下次调用，支持 LF 和跨块的 CRLF。 */
export function parseSseBuffer(buffer: string): {
  events: Array<Record<string, unknown>>;
  rest: string;
} {
  const rawEvents = buffer.replace(/\r\n/g, "\n").split("\n\n");
  const rest = rawEvents.pop() ?? "";
  const events: Array<Record<string, unknown>> = [];
  for (const event of rawEvents) {
    const data: string[] = [];
    for (const line of event.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data:")) data.push(trimmed.slice(5).replace(/^ /, ""));
    }
    if (data.length === 0) continue;
    try {
      events.push(JSON.parse(data.join("\n")) as Record<string, unknown>);
    } catch {
      // 完整但无效的事件不影响后续事件。
    }
  }
  return { events, rest };
}

/** 返回 true 表示业务终止；流结束、提前终止及异常都会取消并释放 reader。 */
export async function consumeSse(
  response: Response,
  onEvent: (event: Record<string, unknown>) => boolean | void,
): Promise<void> {
  const reader = response.body?.getReader?.();
  let buffer = "";
  const dispatch = (text: string): boolean => {
    const parsed = parseSseBuffer(text);
    buffer = parsed.rest;
    for (const event of parsed.events) {
      if (onEvent(event) === true) return true;
    }
    return false;
  };
  if (!reader) {
    // React Native 旧版 fetch 没有 ReadableStream，保留 text() 降级。
    dispatch(`${await response.text()}\n\n`);
    return;
  }
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (dispatch(buffer + decoder.decode(value, { stream: true }))) return;
    }
    dispatch(buffer + decoder.decode() + "\n\n");
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* 连接可能已被中止。 */
    }
    reader.releaseLock();
  }
}
