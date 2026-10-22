import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Badge, Button, Input, Select, Tooltip } from "antd";
import {
  ArrowRightOutlined,
  DatabaseOutlined,
  PauseCircleOutlined,
  SettingOutlined,
  TableOutlined,
  ToolOutlined,
} from "../lib/icons.js";
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

/** 按 12px 字号粗略估算文本渲染宽度（px），用于让模型下拉触发框自适应模型名长度。 */
function estimateTextWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    // 全角字符（中文等）按两倍宽度估算，其余按平均字符宽度估算
    width += ch.charCodeAt(0) > 0xff ? 12 : 7;
  }
  return width;
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
  // 模型名可能很长：让触发框宽度随选中模型自适应，避免截断显示
  const modelSelectWidth = Math.min(Math.max(120, estimateTextWidth(selectedModel) + 36), 260);

  const resourceCount =
    resources.rag.sources.length + resources.mcpTools.length + resources.sqlSources.length;

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
            placeholder="向 Open Agent 提问，或描述要完成的任务…"
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
              <div className="composer-resources" aria-label="对话资源">
                <button
                  type="button"
                  className={`composer-resource-chip${
                    resources.rag.sources.length > 0 ? " is-on" : ""
                  }`}
                  aria-pressed={resources.rag.sources.length > 0}
                  onClick={onConfigureResources}
                >
                  <DatabaseOutlined />
                  知识库
                  {resources.rag.sources.length > 0 ? <b>{resources.rag.sources.length}</b> : null}
                </button>
                <button
                  type="button"
                  className={`composer-resource-chip${
                    resources.sqlSources.length > 0 ? " is-on" : ""
                  }`}
                  aria-pressed={resources.sqlSources.length > 0}
                  onClick={onConfigureResources}
                >
                  <TableOutlined />
                  SQL
                  {resources.sqlSources.length > 0 ? <b>{resources.sqlSources.length}</b> : null}
                </button>
                <button
                  type="button"
                  className={`composer-resource-chip${
                    resources.mcpTools.length > 0 ? " is-on" : ""
                  }`}
                  aria-pressed={resources.mcpTools.length > 0}
                  onClick={onConfigureResources}
                >
                  <ToolOutlined />
                  Tools
                  {resources.mcpTools.length > 0 ? <b>{resources.mcpTools.length}</b> : null}
                </button>
              </div>

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
                  options={modelOptions.map((m) => ({ value: m, label: m, title: m }))}
                  style={{ width: modelSelectWidth }}
                  placeholder="模型"
                  title={selectedModel}
                  className="composer-select"
                  popupMatchSelectWidth={false}
                  classNames={{ popup: { root: "composer-select-popup" } }}
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
                  icon={<ArrowRightOutlined />}
                  onClick={handleSend}
                  disabled={!canSend}
                  title="发送（Enter）"
                  aria-label="发送消息"
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});
