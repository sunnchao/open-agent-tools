import { Layout, Button, Typography } from "antd";
import { HistoryOutlined, PlusOutlined } from "../lib/icons.js";
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
          <div className="chat-session-panel__title">
            <span>
              会话 · <b>{sessions.length}</b>
            </span>
            <HistoryOutlined />
          </div>
          <Button type="primary" block icon={<PlusOutlined />} onClick={onNewChat}>
            新建对话
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
            本地会话 · SQLite
          </Text>
        </div>
      </div>
    </Sider>
  );
}
