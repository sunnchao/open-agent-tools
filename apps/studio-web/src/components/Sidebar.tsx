import { Layout, Button, Typography, Flex } from "antd";
import { PlusOutlined } from "@ant-design/icons";
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
}

export function Sidebar({
  sessions,
  activeId,
  onNewChat,
  onSelect,
  onDelete,
  onRename,
}: SidebarProps) {
  return (
    <Sider
      width={260}
      theme="light"
      style={{
        borderRight: "1px solid rgba(255,255,255,0.08)",
        display: "flex",
        flexDirection: "column",
        height: "100%",
      }}
    >
      <Flex vertical style={{ height: "100%" }}>
        <div style={{ padding: "14px 12px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
          <Text
            type="secondary"
            style={{
              display: "block",
              fontWeight: 700,
              fontSize: 12,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              marginBottom: 12,
            }}
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

        <div style={{ padding: "10px 12px", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
          <Text type="secondary" style={{ fontSize: 11 }}>
            local sessions · v1
          </Text>
        </div>
      </Flex>
    </Sider>
  );
}
