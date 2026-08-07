import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Badge, Button, Input, Select, Tag, Tooltip } from "antd";
import {
  ApiOutlined,
  DatabaseOutlined,
  PauseCircleOutlined,
  SendOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import type { TextAreaRef } from "antd/es/input/TextArea";
import type { ChatResourceBinding } from "../types.js";
import type { ProviderMetadata } from "../features/providers/api.js";

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: (content: string) => void;
  onStop: () => void;
  isStreaming: boolean;
  disabled?: boolean;
  resources: ChatResourceBinding;
  onConfigureResources: () => void;
  /** Provider 列表（已启用），用于底部路由选择。 */
  providers: ProviderMetadata[];
  providerId?: string;
  model?: string;
  onRoutingChange: (routing: { providerId?: string; model?: string }) => void;
}

export interface ComposerHandle {
  focus: () => void;
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    value,
    onChange,
    onSend,
    onStop,
    isStreaming,
    disabled,
    resources,
    onConfigureResources,
    providers,
    providerId,
    model,
    onRoutingChange,
  },
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

  // Provider / 模型兜底
  const selectedProvider =
    providers.find((p) => p.id === providerId) ??
    providers.find((p) => p.id === "default") ??
    providers[0];
  const selectedProviderId = selectedProvider?.id ?? "default";
  const selectedModel = model || selectedProvider?.models[0] || "default";
  const modelOptions = [...new Set([selectedModel, ...(selectedProvider?.models ?? [])])].filter(
    Boolean,
  );

  const resourceCount = resources.rag.sources.length + resources.mcpTools.length;

  return (
    <div className="composer-wrap">
      <div className="chat-col">
        <div className="composer-card">
          {/* 文本区 */}
          <Input.TextArea
            ref={textareaRef}
            className="composer-textarea"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="给助手发送消息…"
            autoSize={{ minRows: 1, maxRows: 8 }}
            disabled={disabled}
            variant="borderless"
            onPressEnter={(e) => {
              const ne = e.nativeEvent as KeyboardEvent;
              if (ne.isComposing || e.shiftKey) return;
              e.preventDefault();
              handleSend();
            }}
          />

          {/* 底部工具栏 */}
          <div className="composer-toolbar">
            {/* 左侧：资源标签 + 选择器 */}
            <div className="composer-toolbar__left">
              {/* 资源标签 */}
              {resources.rag.sources.length > 0 ? (
                <Tag
                  icon={<DatabaseOutlined />}
                  color="orange"
                  style={{ cursor: "pointer", marginInlineEnd: 0 }}
                  onClick={onConfigureResources}
                >
                  RAG {resources.rag.sources.length}
                </Tag>
              ) : null}
              {resources.mcpTools.length > 0 ? (
                <Tag
                  icon={<ApiOutlined />}
                  color="green"
                  style={{ cursor: "pointer", marginInlineEnd: 0 }}
                  onClick={onConfigureResources}
                >
                  MCP {resources.mcpTools.length}
                </Tag>
              ) : null}

              {/* Provider 选择 */}
              {providers.length > 0 ? (
                <Select
                  size="small"
                  variant="borderless"
                  value={selectedProviderId}
                  options={providers.map((p) => ({ value: p.id, label: p.name }))}
                  style={{ minWidth: 100, maxWidth: 160 }}
                  placeholder="Provider"
                  title="模型 Provider"
                  className="composer-select"
                  onChange={(val) => {
                    const p = providers.find((item) => item.id === val);
                    onRoutingChange({ providerId: val, model: p?.models[0] });
                  }}
                />
              ) : null}

              {/* 模型选择 */}
              {modelOptions.length > 0 ? (
                <Select
                  size="small"
                  variant="borderless"
                  value={selectedModel}
                  options={modelOptions.map((m) => ({ value: m, label: m }))}
                  style={{ minWidth: 120, maxWidth: 220 }}
                  placeholder="模型"
                  title="模型"
                  className="composer-select"
                  onChange={(val) => onRoutingChange({ model: val })}
                />
              ) : null}
            </div>

            {/* 右侧：资源配置 + 发送 */}
            <div className="composer-toolbar__right">
              <Tooltip title="配置对话资源">
                <Badge count={resourceCount} size="small" overflowCount={9}>
                  <Button
                    type="text"
                    size="small"
                    icon={<SettingOutlined />}
                    onClick={onConfigureResources}
                    aria-label="配置对话资源"
                    className="composer-icon-btn"
                  />
                </Badge>
              </Tooltip>

              {isStreaming ? (
                <Button
                  danger
                  size="small"
                  icon={<PauseCircleOutlined />}
                  onClick={onStop}
                  title="停止生成"
                >
                  停止
                </Button>
              ) : (
                <Button
                  type="primary"
                  size="small"
                  icon={<SendOutlined />}
                  onClick={handleSend}
                  disabled={!canSend}
                  title="发送（Enter）"
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});
