import { Flex, Tag, Typography } from "antd";

const { Title, Text } = Typography;

interface ChatHeaderProps {
  title: string;
  status: "idle" | "streaming" | "error";
  model: string;
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

export function ChatHeader({ title, status, model }: ChatHeaderProps) {
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
      <div style={{ minWidth: 0 }}>
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
    </Flex>
  );
}
