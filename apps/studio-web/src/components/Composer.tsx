import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
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
  value: string;
  onChange: (value: string) => void;
  onSend: (content: string) => void;
  onStop: () => void;
  isStreaming: boolean;
  disabled?: boolean;
  resources: ChatResourceBinding;
  onConfigureResources: () => void;
}

export interface ComposerHandle {
  focus: () => void;
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { value, onChange, onSend, onStop, isStreaming, disabled, resources, onConfigureResources },
  ref,
) {
  const textareaRef = useRef<TextAreaRef>(null);

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
  }));

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const canSend = value.trim().length > 0 && !isStreaming && !disabled;

  const handleSend = () => {
    if (!canSend) return;
    onSend(value.trim());
    onChange("");
  };

  return (
    <div
      style={{
        padding: "12px 16px 16px",
        borderTop: "1px solid var(--studio-line, #e2e5e9)",
        flexShrink: 0,
      }}
    >
      <div className="chat-col">
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
            onChange={(e) => onChange(e.target.value)}
            placeholder="给助手发送消息…（Enter 发送，Shift+Enter 换行）"
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
            <Button danger icon={<PauseCircleOutlined />} onClick={onStop} title="停止生成">
              停止
            </Button>
          ) : (
            <Button type="primary" icon={<SendOutlined />} onClick={handleSend} disabled={!canSend}>
              发送
            </Button>
          )}
        </Flex>
      </div>
    </div>
  );
});
