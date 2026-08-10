/**
 * 调用本服务 /api/chat 完成一轮知识库问答。
 *
 * 复用平台完整的 Agent Chat 链路（Provider 解析、CRAG 混合检索、工具轮次），
 * 通过 SSE 收集 delta 增量拼出最终文本。返回空串表示无回答。
 */

export interface ChatAnswer {
  content: string;
}

/** 解析一条 SSE 帧（`data: {...}`），返回 delta 增量或 error。非数据帧/坏帧返回 null。 */
export function parseChatSseEvent(line: string): { delta?: string; error?: string } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const payload = trimmed.slice(5).trim();
  if (!payload) return null;
  try {
    const data = JSON.parse(payload) as Record<string, unknown>;
    if (typeof data.delta === "string") return { delta: data.delta };
    if (typeof data.error === "string") return { error: data.error };
  } catch {
    // 忽略无法解析的帧
  }
  return null;
}

export async function askChat(params: {
  baseUrl: string;
  question: string;
  sessionId: string;
  sources: string[];
  topK: number;
  signal?: AbortSignal;
}): Promise<ChatAnswer> {
  const { baseUrl, question, sessionId, sources, topK, signal } = params;
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: question }],
      sessionId,
      resources: { rag: { sources, topK } },
    }),
    signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`chat request failed (${response.status}): ${detail.slice(0, 200)}`);
  }
  if (!response.body) throw new Error("chat response body is empty");

  let content = "";
  let buffer = "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sepIndex: number;
    while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);
      const event = parseChatSseEvent(frame);
      if (!event) continue;
      if (event.error) throw new Error(event.error);
      if (event.delta) content += event.delta;
    }
  }

  return { content: content.trim() };
}
