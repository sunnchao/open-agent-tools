import { useState } from "react";
import { Button, Select, Tooltip, Typography } from "antd";
import type { ProviderMetadata } from "../features/providers/api.js";
import {
  LayersOutlined,
  MoreOutlined,
  PanelLeftCloseOutlined,
  PanelLeftOpenOutlined,
} from "../lib/icons.js";
import { ContextMeter } from "./ContextMeter.js";
import type { ChatCompactReport } from "@open-agent-tools/studio-client";

const { Text } = Typography;

interface ChatHeaderProps {
  title: string;
  messageCount: number;
  compact: ChatCompactReport | null;
  sessionsOpen: boolean;
  overlayMode: boolean;
  providers: ProviderMetadata[];
  providerId?: string;
  model?: string;
  onToggleSessions: () => void;
  onOpenContext: () => void;
  onRoutingChange: (routing: { providerId?: string; model?: string }) => void;
}

export function ChatHeader({
  title,
  messageCount,
  compact,
  sessionsOpen,
  overlayMode,
  providers,
  providerId,
  model,
  onToggleSessions,
  onOpenContext,
  onRoutingChange,
}: ChatHeaderProps) {
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const selectedProvider =
    providers.find((provider) => provider.id === providerId) ??
    providers.find((provider) => provider.id === "default") ??
    providers[0];
  const selectedModel = model ?? selectedProvider?.models[0] ?? "";
  const routingValue =
    selectedProvider && selectedModel ? `${selectedProvider.id}::${selectedModel}` : undefined;
  const routingOptions = providers.flatMap((provider) =>
    provider.models.map((item) => ({
      value: `${provider.id}::${item}`,
      label: item,
    })),
  );

  return (
    <div className="chat-header">
      <div className="chat-col">
        <Tooltip
          title={sessionsOpen ? "收起会话列表" : "展开会话列表"}
          open={tooltipOpen && !(overlayMode && sessionsOpen)}
          onOpenChange={(open) => setTooltipOpen(open && !(overlayMode && sessionsOpen))}
        >
          <Button
            type="text"
            className="chat-header__sessions"
            icon={sessionsOpen ? <PanelLeftCloseOutlined /> : <PanelLeftOpenOutlined />}
            onClick={() => {
              setTooltipOpen(false);
              onToggleSessions();
            }}
            aria-label={sessionsOpen ? "收起会话列表" : "展开会话列表"}
            title={sessionsOpen ? "收起会话列表" : "展开会话列表"}
            aria-expanded={sessionsOpen}
            aria-controls="chat-session-sidebar"
          />
        </Tooltip>
        <div className="chat-header__main">
          <Text className="chat-header__title" ellipsis title={title}>
            {title}
          </Text>
          <span className="chat-header__meta">
            {messageCount} 条消息
            <i>·</i>
            {selectedProvider?.name ?? "未选择模型"}
          </span>
        </div>
        <div className="chat-header__actions">
          <ContextMeter compact={compact} onOpen={onOpenContext} />
          {routingOptions.length > 0 ? (
            <Select
              aria-label="选择模型"
              size="small"
              value={routingValue}
              options={routingOptions}
              className="chat-header__model"
              popupMatchSelectWidth={false}
              onChange={(value: string) => {
                const separator = value.indexOf("::");
                if (separator < 0) return;
                onRoutingChange({
                  providerId: value.slice(0, separator),
                  model: value.slice(separator + 2),
                });
              }}
            />
          ) : null}
          <Tooltip title="对话上下文">
            <Button
              type="text"
              className="chat-header__action"
              icon={<LayersOutlined />}
              aria-label="对话上下文"
              onClick={onOpenContext}
            />
          </Tooltip>
          <Tooltip title={sessionsOpen ? "收起会话列表" : "展开会话列表"}>
            <Button
              type="text"
              className="chat-header__action chat-header__more"
              icon={<MoreOutlined />}
              aria-label={sessionsOpen ? "收起会话列表" : "展开会话列表"}
              onClick={onToggleSessions}
            />
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
