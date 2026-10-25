import { useCallback, useState } from "react";
import type { ChatCompactReport } from "@open-agent-tools/studio-client";

const STORAGE_PREFIX = "oat.chat-context.";

function storageKey(sessionId: string): string {
  return `${STORAGE_PREFIX}${sessionId}`;
}

function readStored(sessionId: string): ChatCompactReport | null {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey(sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ChatCompactReport> | null;
    if (!parsed || typeof parsed.estimatedTokens !== "number" || typeof parsed.inputCap !== "number") {
      return null;
    }
    return parsed as ChatCompactReport;
  } catch {
    return null;
  }
}

/**
 * 会话级上下文快照：内存 + localStorage 双存，切换会话即恢复。
 * render 期只做纯读取（内存优先、存储兜底），不触发 setState。
 */
export function useChatContextStates(): {
  get: (sessionId: string) => ChatCompactReport | null;
  update: (sessionId: string, report: ChatCompactReport) => void;
} {
  const [states, setStates] = useState<Record<string, ChatCompactReport>>({});

  const get = useCallback(
    (sessionId: string) => states[sessionId] ?? readStored(sessionId),
    [states],
  );

  const update = useCallback((sessionId: string, report: ChatCompactReport) => {
    setStates((previous) => ({ ...previous, [sessionId]: report }));
    try {
      globalThis.localStorage?.setItem(storageKey(sessionId), JSON.stringify(report));
    } catch {
      // 隐私模式等写入失败时仅内存生效，不影响本次展示。
    }
  }, []);

  return { get, update };
}
