import { useEffect, useRef, useState } from "react";
import { FloatButton } from "antd";
import { ArrowDownOutlined } from "../lib/icons.js";
import type { Message } from "../types.js";
import { MessageBubble } from "./MessageBubble.js";

interface MessageListProps {
  messages: Message[];
  onRetry?: () => void;
  onRegenerate?: (assistantId: string) => void;
  onSuggestion?: (text: string) => void;
}

const SUGGESTIONS: Array<{ title: string; desc: string; prompt: string }> = [
  { title: "分析财报", desc: "上传或选择数据源，生成结构化分析", prompt: "帮我分析最近一季度的财务表现，并给出关键指标。" },
  { title: "总结文档", desc: "基于已挂载的 RAG 知识库作答", prompt: "请用要点总结知识库中关于产品定价的核心信息。" },
  { title: "调用工具", desc: "通过 MCP 工具完成具体任务", prompt: "调用可用的 MCP 工具，查一下当前系统的运行状态。" },
  { title: "代码助手", desc: "解释、改写或生成代码片段", prompt: "解释下面这段函数的作用，并给出优化建议。" },
];

export function MessageList({
  messages,
  onRetry,
  onRegenerate,
  onSuggestion,
}: MessageListProps) {
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
      <div className="message-list message-list--empty">
        <div className="chat-welcome">
          <h2>有什么可以帮你的？</h2>
          <p>选择下面的示例开始，或直接在下方输入消息。</p>
          <div className="chat-welcome__suggestions">
            {SUGGESTIONS.map((item) => (
              <button
                key={item.title}
                type="button"
                className="chat-welcome__card"
                onClick={() => onSuggestion?.(item.prompt)}
              >
                <b>{item.title}</b>
                <span>{item.desc}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="message-list-shell">
      <div className="message-list" ref={scrollRef} onScroll={handleScroll}>
        <div className="message-list__inner chat-col">
          {messages.map((m) => (
            <MessageBubble
              key={m.id}
              message={m}
              onRetry={m.status === "error" ? onRetry : undefined}
              onRegenerate={
                m.role === "assistant" && m.status === "complete" && onRegenerate
                  ? () => onRegenerate(m.id)
                  : undefined
              }
            />
          ))}
        </div>
      </div>
      {!stickToBottom && (
        <div className="message-list__jump-dock">
          <FloatButton
            className="message-list__jump"
            icon={<ArrowDownOutlined />}
            tooltip="回到最新"
            onClick={jumpToBottom}
          />
        </div>
      )}
    </div>
  );
}
