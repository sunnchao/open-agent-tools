import { useEffect, useRef, useState } from "react";
import { Button, Flex, Input, Tag } from "antd";
import {
  ApiOutlined,
  DatabaseOutlined,
  PauseCircleOutlined,
  SendOutlined,
} from "@ant-design/icons";
import type { TextAreaRef } from "antd/es/input/TextArea";
import type { ChatResourceBinding } from "../types.js";

interface ComposerProps {
  onSend: (content: string) => void;
  onStop: () => void;
  isStreaming: boolean;
  disabled?: boolean;
  resources: ChatResourceBinding;
  onConfigureResources: () => void;
}

export function Composer({
  onSend,
  onStop,
  isStreaming,
  disabled,
  resources,
  onConfigureResources,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<TextAreaRef>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const canSend = value.trim().length > 0 && !isStreaming && !disabled;

  const handleSend = () => {
    if (!canSend) return;
    onSend(value.trim());
    setValue("");
  };

  return (
    <div
      style={{
        padding: "12px 20px 16px",
        borderTop: "1px solid rgba(255,255,255,0.08)",
        flexShrink: 0,
      }}
    >
      {resources.rag.sources.length > 0 || resources.mcpTools.length > 0 ? (
        <div className="composer-resources">
          {resources.rag.sources.length > 0 ? (
            <Tag icon={<DatabaseOutlined />}>RAG {resources.rag.sources.length}</Tag>
          ) : null}
          {resources.mcpTools.length > 0 ? (
            <Tag icon={<ApiOutlined />}>MCP {resources.mcpTools.length}</Tag>
          ) : null}
          <button type="button" onClick={onConfigureResources}>
            调整
          </button>
        </div>
      ) : null}
      <Flex gap={8} align="flex-end">
        <Input.TextArea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Message the model…"
          autoSize={{ minRows: 1, maxRows: 6 }}
          disabled={disabled}
          onPressEnter={(e) => {
            const ne = e.nativeEvent as KeyboardEvent;
            if (ne.isComposing || e.shiftKey) return;
            e.preventDefault();
            handleSend();
          }}
          style={{ flex: 1 }}
        />
        {isStreaming ? (
          <Button danger icon={<PauseCircleOutlined />} onClick={onStop} title="Stop">
            Stop
          </Button>
        ) : (
          <Button type="primary" icon={<SendOutlined />} onClick={handleSend} disabled={!canSend}>
            Send
          </Button>
        )}
      </Flex>
    </div>
  );
}
