import { ApiOutlined, DatabaseOutlined, SettingOutlined } from "@ant-design/icons";
import { Badge, Button, Flex, Tag, Typography } from "antd";

const { Title, Text } = Typography;

interface ChatHeaderProps {
  title: string;
  status: "idle" | "streaming" | "error";
  model: string;
  mcpToolCount: number;
  ragSourceCount: number;
  onConfigureResources: () => void;
}

const STATUS_COLOR: Record<ChatHeaderProps["status"], string> = {
  idle: "default",
  streaming: "processing",
  error: "error",
};

const STATUS_LABEL: Record<ChatHeaderProps["status"], string> = {
  idle: "idle",
  streaming: "streaming…",
  error: "error",
};

export function ChatHeader({
  title,
  status,
  model,
  mcpToolCount,
  ragSourceCount,
  onConfigureResources,
}: ChatHeaderProps) {
  const resourceCount = mcpToolCount + ragSourceCount;
  return (
    <Flex
      align="center"
      justify="space-between"
      style={{
        height: 52,
        padding: "0 20px",
        borderBottom: "1px solid rgba(255,255,255,0.08)",
        flexShrink: 0,
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <Title level={5} style={{ margin: 0 }} ellipsis>
          {title}
        </Title>
        <Flex align="center" gap={8} style={{ marginTop: 2 }}>
          <Tag color={STATUS_COLOR[status]} style={{ marginInlineEnd: 0 }}>
            {STATUS_LABEL[status]}
          </Tag>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {model}
          </Text>
        </Flex>
      </div>
      <Flex align="center" gap={6} className="chat-header-resources">
        {ragSourceCount > 0 ? <Tag icon={<DatabaseOutlined />}>{ragSourceCount}</Tag> : null}
        {mcpToolCount > 0 ? <Tag icon={<ApiOutlined />}>{mcpToolCount}</Tag> : null}
        <Badge count={resourceCount} size="small" overflowCount={99}>
          <Button
            icon={<SettingOutlined />}
            onClick={onConfigureResources}
            title="配置对话资源"
            aria-label="配置对话资源"
          >
            资源
          </Button>
        </Badge>
      </Flex>
    </Flex>
  );
}
