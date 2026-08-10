import { useState } from "react";
import { Button, Tooltip, Typography } from "antd";
import { PanelLeftCloseOutlined, PanelLeftOpenOutlined } from "../lib/icons.js";

const { Text } = Typography;

interface ChatHeaderProps {
  title: string;
  sessionsOpen: boolean;
  overlayMode: boolean;
  onToggleSessions: () => void;
}

export function ChatHeader({
  title,
  sessionsOpen,
  overlayMode,
  onToggleSessions,
}: ChatHeaderProps) {
  const [tooltipOpen, setTooltipOpen] = useState(false);

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
        <Text className="chat-header__title" ellipsis title={title}>
          {title}
        </Text>
      </div>
    </div>
  );
}
