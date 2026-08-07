import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Layout, Spin } from "antd";
import { Sidebar } from "../../components/Sidebar.js";
import { ChatHeader } from "../../components/ChatHeader.js";
import { MessageList } from "../../components/MessageList.js";
import { Composer, type ComposerHandle } from "../../components/Composer.js";
import { useChatSessions } from "../../hooks/useChatSessions.js";
import { useChatStream } from "../../hooks/useChatStream.js";
import { newId } from "../../lib/ids.js";
import type { ChatRequestMessage, Message } from "../../types.js";
import { fetchProviders, type ProviderMetadata } from "../providers/api.js";
import { useResourceCatalog } from "../resources/useResourceCatalog.js";
import { ChatResourceDrawer } from "./ChatResourceDrawer.js";

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
    updateSessionResources,
    updateSessionRouting,
  } = useChatSessions();
  const [resourceDrawerOpen, setResourceDrawerOpen] = useState(false);
  const resources = useResourceCatalog();
  const composerRef = useRef<ComposerHandle>(null);
  const [input, setInput] = useState("");

  // 拉取已启用的 Provider 目录，供对话路由选择。
  const [providers, setProviders] = useState<ProviderMetadata[]>([]);
  useEffect(() => {
    let cancelled = false;
    void fetchProviders()
      .then((items) => {
        if (!cancelled) setProviders(items.filter((provider) => provider.enabled));
      })
      .catch((reason) => {
        console.warn("Failed to load providers for chat routing.", reason);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 切换会话时把焦点交给输入框，提升连续性
  useEffect(() => {
    composerRef.current?.focus();
  }, [activeId]);

  // 会话未显式选择模型时，回退到构建期 VITE_MODEL（保持原有行为）。
  const fallbackModel = import.meta.env.VITE_MODEL as string | undefined;
  const { isStreaming, send, stop } = useChatStream({
    model: activeSession?.model ?? fallbackModel,
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
      send(
        activeSession.id,
        apiMessages,
        { id: userMsg.id, content },
        activeSession.resources,
        {
          providerId: activeSession.providerId ?? providers[0]?.id,
          model: activeSession.model ?? providers[0]?.models[0],
        },
      );
    },
    [activeSession, addMessage, send, providers],
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
      undefined,
      activeSession.resources,
      {
        providerId: activeSession.providerId ?? providers[0]?.id,
        model: activeSession.model ?? providers[0]?.models[0],
      },
    );
  }, [activeSession, removeMessage, send, providers]);

  const handleRegenerate = useCallback(
    (assistantId: string) => {
      if (!activeSession) return;
      const messages = activeSession.messages;
      const idx = messages.findIndex((m) => m.id === assistantId);
      if (idx < 0) return;
      let userIdx = -1;
      for (let i = idx - 1; i >= 0; i--) {
        const current = messages[i];
        if (current?.role === "user") {
          userIdx = i;
          break;
        }
      }
      if (userIdx < 0) return;
      const userMsg = messages[userIdx];
      if (!userMsg) return;
      const trailing = messages.slice(userIdx + 1);
      for (const message of trailing) {
        removeMessage(activeSession.id, message.id);
      }
      const history = messages
        .slice(0, userIdx + 1)
        .filter((m) => m.status !== "error")
        .map((m) => ({ role: m.role, content: m.content }));
      send(
        activeSession.id,
        history,
        { id: userMsg.id, content: userMsg.content },
        activeSession.resources,
        {
          providerId: activeSession.providerId ?? providers[0]?.id,
          model: activeSession.model ?? providers[0]?.models[0],
        },
      );
    },
    [activeSession, removeMessage, send, providers],
  );

  const handleSuggestion = useCallback((text: string) => {
    setInput(text);
    requestAnimationFrame(() => composerRef.current?.focus());
  }, []);

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
        <ChatHeader title={activeSession.title} />
        <MessageList
          messages={activeSession.messages}
          isStreaming={isStreaming}
          onRetry={handleRetry}
          onRegenerate={handleRegenerate}
          onSuggestion={handleSuggestion}
        />
        <Composer
          ref={composerRef}
          value={input}
          onChange={setInput}
          onSend={handleSend}
          onStop={stop}
          isStreaming={isStreaming}
          resources={activeSession.resources}
          onConfigureResources={() => setResourceDrawerOpen(true)}
          providers={providers}
          providerId={activeSession.providerId}
          model={activeSession.model}
          onRoutingChange={(routing) => updateSessionRouting(activeSession.id, routing)}
        />
      </Layout>
      <ChatResourceDrawer
        open={resourceDrawerOpen}
        catalog={resources.catalog}
        loading={resources.loading}
        error={resources.error}
        resources={activeSession.resources}
        onClose={() => setResourceDrawerOpen(false)}
        onRefresh={() => void resources.refresh()}
        onChange={(binding) => updateSessionResources(activeSession.id, binding)}
      />
    </Layout>
  );
}
