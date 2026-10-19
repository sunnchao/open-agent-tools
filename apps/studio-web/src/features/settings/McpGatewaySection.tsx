import { useEffect, useState } from "react";
import { Alert, App, Button, Flex, Form, Input, Typography } from "antd";
import { DeleteOutlined, ReloadOutlined, SaveOutlined } from "../../lib/icons.js";
import { StudioNotice, type StudioNoticeValue } from "../../components/studio/StudioNotice.js";
import { confirmAction } from "../../components/studio/confirmAction.js";
import {
  clearMcpGatewayConfig,
  fetchMcpGatewayConfig,
  saveMcpGatewayConfig,
  type McpGatewayConfig,
} from "./mcpGateway.js";

const sourceLabel: Record<McpGatewayConfig["source"], string> = {
  database: "设置页",
  environment: "环境变量",
  none: "未配置",
};

export function McpGatewaySection() {
  const { message } = App.useApp();
  const [config, setConfig] = useState<McpGatewayConfig | null>(null);
  const [gatewayUrl, setGatewayUrl] = useState("http://localhost:4100");
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<StudioNoticeValue | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchMcpGatewayConfig();
      setConfig(next);
      setGatewayUrl(next.gatewayUrl);
      setApiKey("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "MCP Gateway 配置加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const save = async () => {
    if (!gatewayUrl.trim()) {
      setError("请填写 Gateway 地址");
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const next = await saveMcpGatewayConfig({
        gatewayUrl,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      setConfig(next);
      setGatewayUrl(next.gatewayUrl);
      setApiKey("");
      setNotice({ type: "success", text: "MCP Gateway 已保存。工作流和对话会立即使用这份配置。" });
      void message.success("MCP Gateway 已保存");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "MCP Gateway 配置保存失败");
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const next = await clearMcpGatewayConfig();
      setConfig(next);
      setGatewayUrl(next.gatewayUrl);
      setApiKey("");
      setNotice({ type: "success", text: "已清除设置页配置。" });
      void message.success("已清除设置页配置");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "MCP Gateway 配置清除失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Flex vertical gap={12}>
      {error ? <Alert type="error" showIcon message={error} /> : null}
      <StudioNotice notice={notice} />
      <Flex align="flex-start" justify="space-between" gap={12}>
        <Flex vertical gap={2}>
          <Typography.Text
            type="secondary"
            style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2 }}
          >
            MCP DATA PLANE
          </Typography.Text>
          <Typography.Title level={5} style={{ margin: 0 }}>
            Gateway 连接
          </Typography.Title>
        </Flex>
        <Button
          icon={<ReloadOutlined spin={loading} />}
          disabled={loading || saving}
          onClick={() => void refresh()}
        >
          刷新
        </Button>
      </Flex>
      <Form layout="vertical" onFinish={() => void save()}>
        <Form.Item label="Gateway 地址" required>
          <Input
            aria-label="Gateway 地址"
            required
            value={gatewayUrl}
            disabled={loading || saving}
            onChange={(event) => setGatewayUrl(event.target.value)}
            placeholder="http://localhost:4100"
          />
        </Form.Item>
        <Form.Item
          label="API Key"
          extra={config?.apiKeyMasked ? `当前 ${config.apiKeyMasked}` : "必填"}
        >
          <Input.Password
            aria-label="API Key"
            autoComplete="new-password"
            value={apiKey}
            disabled={loading || saving}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={config?.source === "database" ? "留空则保留当前 Key" : "mcp.xxx.xxx"}
          />
        </Form.Item>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: -8 }}>
          当前来源：{config ? sourceLabel[config.source] : "读取中"}。Key 只保存在 Agent
          Server，不会写入工作流节点。
        </Typography.Paragraph>
        <Flex gap={8} justify="flex-end" wrap>
          <Button
            type="primary"
            htmlType="submit"
            icon={<SaveOutlined />}
            loading={saving}
            disabled={loading || saving}
          >
            {saving ? "保存中" : "保存"}
          </Button>
          {config?.source === "database" ? (
            <Button
              danger
              icon={<DeleteOutlined />}
              disabled={saving}
              onClick={() =>
                confirmAction({
                  title: "清除MCP Gateway配置？",
                  content: "将回退到环境变量，工作流和对话立即生效",
                  onOk: () => void clear(),
                })
              }
            >
              清除并使用环境变量
            </Button>
          ) : null}
        </Flex>
      </Form>
    </Flex>
  );
}
