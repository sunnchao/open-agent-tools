import { useEffect, useRef, useState } from "react";
import { Button, Flex, Input } from "antd";
import { SendOutlined, PauseCircleOutlined } from "@ant-design/icons";
import type { TextAreaRef } from "antd/es/input/TextArea";

interface ComposerProps {
  onSend: (content: string) => void;
  onStop: () => void;
  isStreaming: boolean;
  disabled?: boolean;
}

export function Composer({ onSend, onStop, isStreaming, disabled }: ComposerProps) {
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
