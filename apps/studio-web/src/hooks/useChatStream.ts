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

  const send = useCallback(
    (
      sessionId: string,
      messages: ChatRequestMessage[],
      userMessage?: { id: string; content: string },
      resources?: ChatResourceBinding,
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

      controllerRef.current = streamChat(
        messages,
        model,
        {
          onAssistantMessageId: (id) => {
            if (id === assistantId) return;
            const prevId = assistantId;
            assistantId = id;
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
            setIsStreaming(false);
            controllerRef.current = null;
          },
          onError: (error) => {
            updateMessage(sessionId, assistantId, { status: "error", content: error });
            setIsStreaming(false);
            controllerRef.current = null;
          },
        },
        {
          sessionId,
          userMessage,
          resources,
        },
      );
    },
    [model, addMessage, appendDelta, updateMessage, addToolCall, updateToolCall],
  );

  const stop = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setIsStreaming(false);
  }, []);

  return { isStreaming, send, stop };
}
