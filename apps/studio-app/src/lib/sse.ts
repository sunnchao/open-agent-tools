/** SSE 缓冲按事件边界切分（与 Web 版 parseSseBuffer 同语义，RN 复用）。 */
export function parseSseBuffer(buffer: string): {
  events: Array<Record<string, unknown>>;
  rest: string;
} {
  const rawEvents = buffer.split("\n\n");
  const rest = rawEvents.pop() ?? "";
  const events: Array<Record<string, unknown>> = [];
  for (const event of rawEvents) {
    let dataValue = "";
    let hasData = false;
    for (const line of event.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const value = trimmed.slice("data:".length).replace(/^ /, "");
      dataValue += (hasData ? "\n" : "") + value;
      hasData = true;
    }
    if (!hasData) continue;
    try {
      events.push(JSON.parse(dataValue) as Record<string, unknown>);
    } catch {
      // 半包 JSON 等待后续拼齐
    }
  }
  return { events, rest };
}

/** 把 fetch Response 的 body 按 SSE 逐事件消费，兼容 RN(ReadableStream/Blob/text 三种形态)。 */
export async function consumeSse(
  response: Response,
  onEvent: (event: Record<string, unknown>) => boolean | void,
): Promise<void> {
  const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader?.();
  if (reader) {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseBuffer(buffer.replace(/\r\n/g, "\n"));
        buffer = parsed.rest;
        for (const event of parsed.events) {
          if (onEvent(event) === true) return;
        }
      }
      // 尾包（无 \n\n 结尾）尝试再解析一次
      if (buffer.trim()) {
        const parsed = parseSseBuffer(`${buffer}\n\n`);
        for (const event of parsed.events) {
          if (onEvent(event) === true) return;
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* noop */
      }
      try {
        reader.releaseLock();
      } catch {
        /* noop */
      }
    }
    return;
  }
  // RN Android 旧形态：一次性 text
  const text = await response.text();
  const parsed = parseSseBuffer(text.includes("\n\n") ? text : `${text}\n\n`);
  for (const event of parsed.events) {
    if (onEvent(event) === true) return;
  }
}
