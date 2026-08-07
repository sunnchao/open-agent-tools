import { Typography } from "antd";

const { Text } = Typography;

interface ChatHeaderProps {
  title: string;
}

export function ChatHeader({ title }: ChatHeaderProps) {
  return (
    <div className="chat-header">
      <div className="chat-col">
        <Text className="chat-header__title" ellipsis title={title}>
          {title}
        </Text>
      </div>
    </div>
  );
}
