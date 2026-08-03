import { useCallback, useEffect, useRef, useState } from "react";
import type { Message, Session, ToolCall } from "../types.js";
import { newId } from "../lib/ids.js";
import {
  createSessionApi,
  deleteMessageApi,
  deleteSessionApi,
  fetchSessions,
  renameSessionApi,
} from "../lib/api.js";
import { loadSessions, saveSessions } from "../lib/storage.js";

function createLocalSession(): Session {
  return {
    id: newId(),
    title: "New chat",
    messages: [],
    updatedAt: Date.now(),
  };
}

function autoTitle(content: string): string {
  const trimmed = content.trim().replace(/\n/g, " ");
  return trimmed.length > 32 ? trimmed.slice(0, 32) + "…" : trimmed || "New chat";
}

export function useChatSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [ready, setReady] = useState(false);
  const bootstrapped = useRef(false);

  // —— 持久化（缓存）——
  // 本地 localStorage 作为对话记录（含 function calling）的权威缓存，
  // 刷新页面后直接从此处恢复，保证历史数据（含工具调用）正常显示。
  // 同时尽力与服务端 (/api/sessions) 同步，保持多端/服务端索引一致。
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;

    (async () => {
      try {
        const local = loadSessions();
        if (local.length > 0) {
          setSessions(local);
          setActiveId(local[0]!.id);
          setReady(true);
          return;
        }
      } catch {
        // 本地读取失败，回退到服务端。
      }
      try {
        let loaded = await fetchSessions();
        if (loaded.length === 0) {
          const created = await createSessionApi();
          loaded = [created];
        }
        setSessions(loaded);
        setActiveId(loaded[0]!.id);
        saveSessions(loaded);
      } catch (err) {
        console.warn("Failed to load sessions; using local fallback.", err);
        const local = createLocalSession();
        setSessions([local]);
        setActiveId(local.id);
        saveSessions([local]);
      } finally {
        setReady(true);
      }
    })();
  }, []);

  // 会话变化即写回本地缓存（防抖），保证刷新后可恢复。
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => saveSessions(sessions), 250);
    return () => clearTimeout(t);
  }, [sessions, ready]);

  // 若当前无会话（本地与服务端都为空或刚被清空），补一个本地会话。
  useEffect(() => {
    if (!ready) return;
    if (sessions.length === 0) {
      void (async () => {
        try {
          const created = await createSessionApi();
          setSessions([created]);
          setActiveId(created.id);
          saveSessions([created]);
        } catch {
          const local = createLocalSession();
          setSessions([local]);
          setActiveId(local.id);
          saveSessions([local]);
        }
      })();
      return;
    }
    if (!sessions.some((s) => s.id === activeId)) {
      setActiveId(sessions[0]!.id);
    }
  }, [sessions, activeId, ready]);

  const activeSession = sessions.find((s) => s.id === activeId) ?? null;

  const newChat = useCallback(async () => {
    const s: Session = {
      id: newId(),
      title: "New chat",
      messages: [],
      updatedAt: Date.now(),
    };
    setSessions((prev) => [s, ...prev]);
    setActiveId(s.id);
    saveSessions([s, ...sessions]);
    void createSessionApi({ id: s.id, title: s.title }).catch(() => {});
  }, [sessions]);

  const selectSession = useCallback((id: string) => {
    setActiveId(id);
  }, []);

  const deleteSession = useCallback(
    async (id: string) => {
      try {
        await deleteSessionApi(id);
      } catch (err) {
        console.warn("deleteSession failed", err);
      }
      setSessions((prev) => {
        const next = prev.filter((s) => s.id !== id);
        if (next.length === 0) {
          const fresh = createLocalSession();
          void createSessionApi({ id: fresh.id }).then((created) => {
            setSessions([created]);
            setActiveId(created.id);
            saveSessions([created]);
          });
          setActiveId(fresh.id);
          return [fresh];
        }
        if (id === activeId) {
          setActiveId(next[0]!.id);
        }
        return next;
      });
    },
    [activeId],
  );

  const renameSession = useCallback(
    async (id: string, title: string) => {
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, title, updatedAt: Date.now() } : s)),
      );
      try {
        const updated = await renameSessionApi(id, title);
        setSessions((prev) =>
          prev.map((s) => (s.id === id ? { ...updated, messages: s.messages } : s)),
        );
      } catch (err) {
        console.warn("renameSession failed", err);
      }
    },
    [],
  );

  const addMessage = useCallback((sessionId: string, message: Message) => {
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== sessionId) return s;
        const messages = [...s.messages, message];
        let title = s.title;
        if (s.title === "New chat" && message.role === "user") {
          title = autoTitle(message.content);
        }
        return { ...s, messages, title, updatedAt: Date.now() };
      }),
    );
  }, []);

  const updateMessage = useCallback(
    (sessionId: string, messageId: string, patch: Partial<Message>) => {
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sessionId) return s;
          return {
            ...s,
            messages: s.messages.map((m) => {
              if (m.id !== messageId && m.id !== patch.id) return m;
              return { ...m, ...patch };
            }),
            updatedAt: Date.now(),
          };
        }),
      );
    },
    [],
  );

  const appendMessageDelta = useCallback((sessionId: string, messageId: string, delta: string) => {
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== sessionId) return s;
        const hasExact = s.messages.some((m) => m.id === messageId);
        return {
          ...s,
          messages: s.messages.map((m) => {
            if (m.id === messageId) return { ...m, content: m.content + delta };
            if (!hasExact && m.role === "assistant" && m.status === "streaming") {
              return { ...m, content: m.content + delta };
            }
            return m;
          }),
        };
      }),
    );
  }, []);

  /**
   * 给某条助手消息追加一次工具调用（function calling 记录）。
   * 以 tool call id 为键；若缺失 id 则追加到数组末尾。
   */
  const addToolCall = useCallback(
    (sessionId: string, messageId: string, toolCall: ToolCall) => {
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sessionId) return s;
          return {
            ...s,
            messages: s.messages.map((m) => {
              if (m.id !== messageId) return m;
              const toolCalls = [...(m.toolCalls ?? []), toolCall];
              return {
                ...m,
                toolCalls,
                uiBlocks: toolCall.ui ? [...(m.uiBlocks ?? []), toolCall.ui] : m.uiBlocks,
              };
            }),
            updatedAt: Date.now(),
          };
        }),
      );
    },
    [],
  );

  /**
   * 更新某条助手消息里匹配的工具调用（按 id；id 缺失时取最后一条）。
   */
  const updateToolCall = useCallback(
    (sessionId: string, messageId: string, toolCallId: string | undefined, patch: Partial<ToolCall>) => {
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sessionId) return s;
          return {
            ...s,
            messages: s.messages.map((m) => {
              if (m.id !== messageId) return m;
              const toolCalls = (m.toolCalls ?? []).map((tc, idx, arr) => {
                const matches =
                  toolCallId != null
                    ? (tc.id ?? null) === toolCallId
                    : idx === arr.length - 1;
                return matches ? { ...tc, ...patch } : tc;
              });
              const ui =
                patch.ui && !m.uiBlocks?.some((b) => b === patch.ui)
                  ? [...(m.uiBlocks ?? []), patch.ui]
                  : m.uiBlocks;
              return { ...m, toolCalls, uiBlocks: ui };
            }),
            updatedAt: Date.now(),
          };
        }),
      );
    },
    [],
  );

  const removeMessage = useCallback((sessionId: string, messageId: string) => {
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== sessionId) return s;
        return {
          ...s,
          messages: s.messages.filter((m) => m.id !== messageId),
          updatedAt: Date.now(),
        };
      }),
    );
    void deleteMessageApi(messageId).catch((err) => console.warn("deleteMessage failed", err));
  }, []);

  return {
    ready,
    sessions,
    activeId,
    activeSession,
    newChat,
    selectSession,
    deleteSession,
    renameSession,
    addMessage,
    updateMessage,
    appendMessageDelta,
    addToolCall,
    updateToolCall,
    removeMessage,
  };
}
