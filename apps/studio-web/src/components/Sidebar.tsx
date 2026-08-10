import { Layout, Button, Typography } from "antd";
import { PlusOutlined } from "../lib/icons.js";
import type { Session } from "../types.js";
import { SessionList } from "./SessionList.js";

const { Sider } = Layout;
const { Text } = Typography;

interface SidebarProps {
  sessions: Session[];
  activeId: string;
  onNewChat: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  collapsed: boolean;
}

export function Sidebar({
  sessions,
  activeId,
  onNewChat,
  onSelect,
  onDelete,
  onRename,
  collapsed,
}: SidebarProps) {
  return (
    <Sider
      id="chat-session-sidebar"
      width={248}
      collapsedWidth={0}
      collapsed={collapsed}
      collapsible
      trigger={null}
      theme="light"
      className="chat-session-sidebar"
    >
      <div className="chat-session-panel">
        <div className="chat-session-panel__head">
          <Text
            type="secondary"
            className="chat-session-panel__eyebrow"
          >
            Agent Chat
          </Text>
          <Button type="primary" block icon={<PlusOutlined />} onClick={onNewChat}>
            New chat
          </Button>
        </div>

        <SessionList
          sessions={sessions}
          activeId={activeId}
          onSelect={onSelect}
          onDelete={onDelete}
          onRename={onRename}
        />

        <div className="chat-session-panel__foot">
          <Text type="secondary">
            local sessions · v1
          </Text>
        </div>
      </div>
    </Sider>
  );
}
