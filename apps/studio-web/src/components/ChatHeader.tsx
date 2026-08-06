import { ApiOutlined, DatabaseOutlined, SettingOutlined } from "@ant-design/icons";
import { Badge, Button, Flex, Select, Tag, Typography } from "antd";
import type { ProviderMetadata } from "../features/providers/api.js";

const { Title } = Typography;

interface ChatHeaderProps {
  title: string;
  status: "idle" | "streaming" | "error";
  /** 已配置的 Provider 列表（已启用）。 */
  providers: ProviderMetadata[];
  /** 当前会话选中的 Provider id（缺省走 default）。 */
  providerId?: string;
  /** 当前会话选中的模型（缺省由服务端回退到 Provider 的第一个模型）。 */
  model?: string;
  /** 用户修改路由（Provider / 模型）时回调。 */
  onRoutingChange: (routing: { providerId?: string; model?: string }) => void;
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
  providers,
  providerId,
  model,
  onRoutingChange,
  mcpToolCount,
  ragSourceCount,
  onConfigureResources,
}: ChatHeaderProps) {
  const resourceCount = mcpToolCount + ragSourceCount;

  // 展示值兜底：会话未选择、或所选 Provider 已被删除时，回落到 default（服务端路由保证存在）。
  const selectedProvider =
    providers.find((provider) => provider.id === providerId) ??
    providers.find((provider) => provider.id === "default") ??
    providers[0];
  const selectedProviderId = selectedProvider?.id ?? "default";
  const selectedModel = model || selectedProvider?.models[0] || "default";
  const modelOptions = [...new Set([selectedModel, ...(selectedProvider?.models ?? [])])].filter(
    Boolean,
  );

  return (
    <Flex
      align="center"
      justify="space-between"
      style={{
        height: 52,
        padding: "0 20px",
        borderBottom: "1px solid rgba(255,255,255,0.08)",
        flexShrink: 0,
        gap: 12,
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
        </Flex>
      </div>
      <Flex align="center" gap={8} wrap="wrap">
        <Select
          size="small"
          value={selectedProviderId}
          options={providers.map((provider) => ({ value: provider.id, label: provider.name }))}
          style={{ minWidth: 140 }}
          placeholder="Provider"
          title="模型 Provider（路由）"
          onChange={(value) => {
            const provider = providers.find((item) => item.id === value);
            onRoutingChange({ providerId: value, model: provider?.models[0] });
          }}
        />
        <Select
          size="small"
          value={selectedModel}
          options={modelOptions.map((item) => ({ value: item, label: item }))}
          style={{ minWidth: 150 }}
          placeholder="模型"
          title="模型"
          onChange={(value) => onRoutingChange({ model: value })}
        />
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
    </Flex>
  );
}
