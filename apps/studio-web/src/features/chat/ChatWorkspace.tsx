import { useCallback, useMemo } from "react";
import { Layout, Spin } from "antd";
import { Sidebar } from "../../components/Sidebar.js";
import { ChatHeader } from "../../components/ChatHeader.js";
import { MessageList } from "../../components/MessageList.js";
import { Composer } from "../../components/Composer.js";
import { useChatSessions } from "../../hooks/useChatSessions.js";
import { useChatStream } from "../../hooks/useChatStream.js";
import { newId } from "../../lib/ids.js";
import type { ChatRequestMessage, Message } from "../../types.js";

export function ChatWorkspace() {
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
          .filter((message) => message.status !== "error")
          .map((message) => ({ role: message.role, content: message.content })),
        { role: "user", content },
      ];
      send(activeSession.id, apiMessages, { id: userMsg.id, content });
    },
    [activeSession, addMessage, send],
  );

  const handleRetry = useCallback(() => {
    if (!activeSession) return;
    const lastError = [...activeSession.messages]
      .reverse()
      .find((message) => message.status === "error");
    if (!lastError) return;
    removeMessage(activeSession.id, lastError.id);
    const index = activeSession.messages.findIndex((message) => message.id === lastError.id);
    const previousMessages = activeSession.messages.slice(0, index);
    const lastUser = [...previousMessages].reverse().find((message) => message.role === "user");
    if (!lastUser) return;
    send(
      activeSession.id,
      previousMessages
        .filter((message) => message.status !== "error")
        .map((message) => ({ role: message.role, content: message.content })),
    );
  }, [activeSession, removeMessage, send]);

  const status: "idle" | "streaming" | "error" = useMemo(() => {
    if (isStreaming) return "streaming";
    if (activeSession?.messages.some((message) => message.status === "error")) return "error";
    return "idle";
  }, [activeSession, isStreaming]);

  if (!ready || !activeSession) {
    return (
      <Layout className="studio-loading">
        <Spin size="large" />
      </Layout>
    );
  }

  return (
    <Layout className="chat-workspace">
      <Sidebar
        sessions={sessions}
        activeId={activeId}
        onNewChat={() => void newChat()}
        onSelect={selectSession}
        onDelete={(id) => void deleteSession(id)}
        onRename={(id, title) => void renameSession(id, title)}
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
