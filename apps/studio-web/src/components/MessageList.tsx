import { useEffect, useRef, useState } from "react";
import { Empty, FloatButton } from "antd";
import { ArrowDownOutlined } from "@ant-design/icons";
import type { Message } from "../types.js";
import { MessageBubble } from "./MessageBubble.js";

interface MessageListProps {
  messages: Message[];
  isStreaming: boolean;
  onRetry?: () => void;
}

export function MessageList({ messages, isStreaming, onRetry }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);

  useEffect(() => {
    if (stickToBottom && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, stickToBottom]);

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 60;
    setStickToBottom(atBottom);
  };

  const jumpToBottom = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      setStickToBottom(true);
    }
  };

  if (messages.length === 0) {
    return (
      <div className="message-list" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Empty description="Start a conversation" />
      </div>
    );
  }

  return (
    <div className="message-list" ref={scrollRef} onScroll={handleScroll}>
      {messages.map((m) => (
        <MessageBubble
          key={m.id}
          message={m}
          onRetry={m.status === "error" ? onRetry : undefined}
        />
      ))}
      {!stickToBottom && isStreaming && (
        <FloatButton
          icon={<ArrowDownOutlined />}
          tooltip="Jump to latest"
          onClick={jumpToBottom}
          style={{ position: "sticky", bottom: 16, left: "50%", transform: "translateX(-50%)" }}
        />
      )}
    </div>
  );
}
