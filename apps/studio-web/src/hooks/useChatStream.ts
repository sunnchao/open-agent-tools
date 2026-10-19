import { useCallback, useRef, useState } from "react";
import type { ChatRequestMessage, ChatResourceBinding, Message, ToolCall } from "../types.js";
import { newId } from "../lib/ids.js";
import { streamChat } from "../lib/api.js";

interface UseChatStreamArgs {
  model: string | undefined;
  addMessage: (sessionId: string, message: Message) => void;
  appendDelta: (sessionId: string, messageId: string, delta: string) => void;
  updateMessage: (sessionId: string, messageId: string, patch: Partial<Message>) => void;
  addToolCall: (sessionId: string, messageId: string, toolCall: ToolCall) => void;
  updateToolCall: (
    sessionId: string,
    messageId: string,
    toolCallId: string | undefined,
    patch: Partial<ToolCall>,
  ) => void;
}

export function useChatStream({
  model,
  addMessage,
  appendDelta,
  updateMessage,
  addToolCall,
  updateToolCall,
}: UseChatStreamArgs) {
  const [isStreaming, setIsStreaming] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const activeRef = useRef<{ sessionId: string; assistantId: string } | null>(null);

  const send = useCallback(
    (
      sessionId: string,
      messages: ChatRequestMessage[],
      userMessage?: { id: string; content: string },
      resources?: ChatResourceBinding,
      routing?: { providerId?: string; model?: string },
    ) => {
      // 本地乐观占位；服务端稍后分配规范的 assistant id。
      const localAssistantId = newId();
      let assistantId = localAssistantId;

      addMessage(sessionId, {
        id: localAssistantId,
        role: "assistant",
        content: "",
        createdAt: Date.now(),
        status: "streaming",
      });

      setIsStreaming(true);
      activeRef.current = { sessionId, assistantId: localAssistantId };

      controllerRef.current = streamChat(
        messages,
        routing?.model ?? model,
        {
          onAssistantMessageId: (id) => {
            if (id === assistantId) return;
            const prevId = assistantId;
            assistantId = id;
            if (activeRef.current?.sessionId === sessionId) {
              activeRef.current = { sessionId, assistantId: id };
            }
            updateMessage(sessionId, prevId, { id });
          },
          onDelta: (delta) => {
            appendDelta(sessionId, assistantId, delta);
          },
          onRagCitations: (ragCitations) => {
            updateMessage(sessionId, assistantId, { ragCitations });
          },
          onToolCall: (call) => {
            // 记录一次“函数调用请求”（name + arguments），作为对话记录的一部分。
            addToolCall(sessionId, assistantId, {
              ...call,
              status: "pending",
            });
          },
          onToolResult: ({ id, name, result, ui, error }) => {
            updateToolCall(sessionId, assistantId, id, {
              name,
              ...(result !== undefined ? { result } : {}),
              ...(ui !== undefined ? { ui } : {}),
              ...(error !== undefined ? { error } : {}),
              status: error ? "error" : "done",
            });
          },
          onDone: (meta) => {
            if (meta?.assistantMessageId && meta.assistantMessageId !== assistantId) {
              updateMessage(sessionId, assistantId, { id: meta.assistantMessageId });
              assistantId = meta.assistantMessageId;
            }
            updateMessage(sessionId, assistantId, { status: "complete" });
            activeRef.current = null;
            setIsStreaming(false);
            controllerRef.current = null;
          },
          onError: (error) => {
            // 保留已收到的 partial，错误文案单独展示。
            updateMessage(sessionId, assistantId, { status: "error", errorMessage: error });
            activeRef.current = null;
            setIsStreaming(false);
            controllerRef.current = null;
          },
          onStopped: () => {
            // stop() 已经写过 stopped。这里只清引用，避免同一次停止写两次。
            activeRef.current = null;
            setIsStreaming(false);
            controllerRef.current = null;
          },
        },
        {
          sessionId,
          userMessage,
          resources,
          ...(routing?.providerId ? { providerId: routing.providerId } : {}),
        },
      );
    },
    [model, addMessage, appendDelta, updateMessage, addToolCall, updateToolCall],
  );

  const stop = useCallback(() => {
    const active = activeRef.current;
    controllerRef.current?.abort();
    controllerRef.current = null;
    activeRef.current = null;
    // 服务端 abort 接线属于 P0-1。这里只结束本地假转圈，保留已生成内容。
    if (active) {
      updateMessage(active.sessionId, active.assistantId, { status: "stopped" });
    }
    setIsStreaming(false);
  }, [updateMessage]);

  return { isStreaming, send, stop };
}
