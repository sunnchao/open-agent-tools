import { useCallback, useMemo } from "react";
import { Layout, Spin } from "antd";
import { Sidebar } from "./components/Sidebar.js";
import { ChatHeader } from "./components/ChatHeader.js";
import { MessageList } from "./components/MessageList.js";
import { Composer } from "./components/Composer.js";
import { useChatSessions } from "./hooks/useChatSessions.js";
import { useChatStream } from "./hooks/useChatStream.js";
import { newId } from "./lib/ids.js";
import type { ChatRequestMessage, Message } from "./types.js";

export function App() {
  const {
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
  } = useChatSessions();

  const model = import.meta.env.VITE_MODEL as string | undefined;

  const { isStreaming, send, stop } = useChatStream({
    model,
    addMessage,
    appendDelta: appendMessageDelta,
    updateMessage,
    addToolCall,
    updateToolCall,
  });

  const handleSend = useCallback(
    (content: string) => {
      if (!activeSession) return;

      const userMsg: Message = {
        id: newId(),
        role: "user",
        content,
        createdAt: Date.now(),
        status: "complete",
      };
      addMessage(activeSession.id, userMsg);

      const apiMessages: ChatRequestMessage[] = [
        ...activeSession.messages
          .filter((m) => m.status !== "error")
          .map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content },
      ];

      send(activeSession.id, apiMessages, { id: userMsg.id, content });
    },
    [activeSession, addMessage, send],
  );

  const handleRetry = useCallback(() => {
    if (!activeSession) return;
    const lastError = [...activeSession.messages].reverse().find((m) => m.status === "error");
    if (!lastError) return;
    removeMessage(activeSession.id, lastError.id);

    const idx = activeSession.messages.findIndex((m) => m.id === lastError.id);
    const userMessages = activeSession.messages.slice(0, idx);
    const lastUser = [...userMessages].reverse().find((m) => m.role === "user");
    if (!lastUser) return;

    const apiMessages: ChatRequestMessage[] = userMessages
      .filter((m) => m.status !== "error")
      .map((m) => ({ role: m.role, content: m.content }));

    // Retry does not re-insert the user message; only regenerate assistant.
    send(activeSession.id, apiMessages);
  }, [activeSession, removeMessage, send]);

  const status: "idle" | "streaming" | "error" = useMemo(() => {
    if (isStreaming) return "streaming";
    if (activeSession?.messages.some((m) => m.status === "error")) return "error";
    return "idle";
  }, [isStreaming, activeSession]);

  if (!ready || !activeSession) {
    return (
      <Layout style={{ height: "100vh", alignItems: "center", justifyContent: "center" }}>
        <Spin size="large" />
      </Layout>
    );
  }

  return (
    <Layout style={{ height: "100vh" }}>
      <Sidebar
        sessions={sessions}
        activeId={activeId}
        onNewChat={() => {
          void newChat();
        }}
        onSelect={selectSession}
        onDelete={(id) => {
          void deleteSession(id);
        }}
        onRename={(id, title) => {
          void renameSession(id, title);
        }}
      />
      <Layout className="chat-main">
        <ChatHeader title={activeSession.title} status={status} model={model ?? "default"} />
        <MessageList
          messages={activeSession.messages}
          isStreaming={isStreaming}
          onRetry={handleRetry}
        />
        <Composer onSend={handleSend} onStop={stop} isStreaming={isStreaming} />
      </Layout>
    </Layout>
  );
}
