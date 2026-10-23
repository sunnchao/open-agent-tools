import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Flex,
  Form,
  Input,
  List,
  Modal,
  Select,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
  ApiOutlined,
  CheckCircleFilled,
  KeyOutlined,
  LoadingOutlined,
  ReloadOutlined,
  SendOutlined,
  TagOutlined,
  ToolOutlined,
} from "../../lib/icons.js";
import {
  listClients,
  listGrants,
  listMarketplaceServices,
  upsertGrant,
  type ApiClientRecord,
  type ClientGrantRecord,
  type MarketplaceService,
  type McpScope,
} from "./api.js";
import { callGatewayTool } from "./gateway.js";
import { errorMessage as messageFrom } from "@open-agent-tools/api-contracts/values";

function toolCountLabel(service: MarketplaceService): string {
  return service.toolsUnknown ? "Tools 未知" : `${service.toolCount ?? 0} Tools`;
}

export function MarketplaceView() {
  const { message } = App.useApp();
  const [services, setServices] = useState<MarketplaceService[]>([]);
  const [clients, setClients] = useState<ApiClientRecord[]>([]);
  const [selectedClientId, setSelectedClientId] = useState<string>("");
  const [grants, setGrants] = useState<ClientGrantRecord[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [trialService, setTrialService] = useState<MarketplaceService | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [toolName, setToolName] = useState("");
  const [trialArguments, setTrialArguments] = useState("{}");
  const [trialResult, setTrialResult] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [nextServices, nextClients] = await Promise.all([
        listMarketplaceServices(),
        listClients(),
      ]);
      setServices(nextServices);
      setClients(nextClients);
      setSelectedClientId((current) =>
        nextClients.some((client) => client.id === current) ? current : (nextClients[0]?.id ?? ""),
      );
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => void load(), [load]);

  useEffect(() => {
    if (!selectedClientId) {
      setGrants([]);
      return;
    }
    let cancelled = false;
    listGrants(selectedClientId)
      .then((next) => {
        if (!cancelled) setGrants(next);
      })
      .catch((reason) => {
        if (!cancelled) setError(messageFrom(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedClientId]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return services;
    return services.filter((service) => {
      const haystack = [
        service.name,
        service.slug,
        ...service.tools.map((tool) => `${tool.name} ${tool.description ?? ""}`),
        ...service.prompts.map((prompt) => `${prompt.name} ${prompt.title ?? ""}`),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [search, services]);

  const subscribe = async (service: MarketplaceService) => {
    if (!selectedClientId) return;
    setBusy(service.id);
    setError("");
    try {
      const scopes: McpScope[] = ["mcp:connect"];
      if (service.toolsUnknown || (service.toolCount ?? 0) > 0) {
        scopes.push("tools:list", "tools:call");
      }
      if (service.promptCount > 0) scopes.push("prompts:list", "prompts:get");
      await upsertGrant(selectedClientId, service.id, {
        scopes,
        toolNames: null,
        promptNames: null,
      });
      setGrants(await listGrants(selectedClientId));
      void message.success(`已为客户端订阅 ${service.name}`);
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setBusy(null);
    }
  };

  const openTrial = (service: MarketplaceService) => {
    setTrialService(service);
    setToolName(service.tools[0]?.name ?? "");
    setTrialArguments("{}");
    setTrialResult("");
    setError("");
  };

  const runTrial = async () => {
    if (!trialService) return;
    setBusy("trial");
    setError("");
    setTrialResult("");
    try {
      const args = JSON.parse(trialArguments) as unknown;
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        throw new Error("试用参数必须是 JSON 对象");
      }
      const result = await callGatewayTool({
        serviceSlug: trialService.slug,
        apiKey,
        toolName,
        arguments: args as Record<string, unknown>,
      });
      setTrialResult(JSON.stringify(result, null, 2));
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Flex vertical gap={12}>
      <Card size="small">
        <Flex gap={12} align="center" wrap>
          <Flex vertical gap={0}>
            <Typography.Text strong>工具市场</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {services.length} 个已发布服务
            </Typography.Text>
          </Flex>
          <Form.Item label="订阅客户端" style={{ marginBottom: 0 }}>
            <Select
              aria-label="订阅客户端"
              value={selectedClientId || undefined}
              onChange={(value) => setSelectedClientId(value)}
              placeholder="选择客户端"
              options={clients.map((client) => ({ value: client.id, label: client.name }))}
              style={{ minWidth: 160 }}
            />
          </Form.Item>
          <Input.Search
            aria-label="搜索服务"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索服务、Tool 或 Prompt"
            allowClear
            style={{ flex: 1, minWidth: 200 }}
          />
          <Tooltip title="刷新">
            <Button icon={<ReloadOutlined spin={loading} />} onClick={() => void load()} aria-label="刷新" />
          </Tooltip>
        </Flex>
      </Card>
      {error ? <Alert type="error" showIcon message={error} role="alert" /> : null}
      {loading ? (
        <Flex justify="center" style={{ padding: 48 }}>
          <Spin aria-label="正在读取已发布服务" />
        </Flex>
      ) : visible.length === 0 ? (
        <Empty description="没有匹配的服务" />
      ) : (
        <List
          grid={{ gutter: 12, xs: 1, sm: 2, md: 2, lg: 3, xl: 3, xxl: 4 }}
          dataSource={visible}
          rowKey="id"
          renderItem={(service) => {
            const subscribed = grants.some((grant) => grant.serviceId === service.id);
            return (
              <List.Item>
                <Card
                  size="small"
                  title={
                    <Flex gap={8} align="center">
                      <ApiOutlined />
                      <Typography.Text strong ellipsis style={{ maxWidth: 140 }}>
                        {service.name}
                      </Typography.Text>
                    </Flex>
                  }
                  extra={<Tag>{service.type === "REMOTE_MCP" ? "REMOTE" : "MANAGED"}</Tag>}
                >
                  <Flex vertical gap={8}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      /{service.slug} · v{service.versionNumber}
                    </Typography.Text>
                    <Flex gap={8} wrap>
                      <Tag icon={<ToolOutlined />}>{toolCountLabel(service)}</Tag>
                      <Tag icon={<TagOutlined />}>{service.promptCount} Prompts</Tag>
                    </Flex>
                    {service.tools.length > 0 ? (
                      <Flex gap={4} wrap>
                        {service.tools.slice(0, 4).map((tool) => (
                          <Tag key={tool.name}>{tool.name}</Tag>
                        ))}
                        {service.tools.length > 4 ? (
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            +{service.tools.length - 4}
                          </Typography.Text>
                        ) : null}
                      </Flex>
                    ) : (
                      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
                        {service.toolsUnknown
                          ? "Remote MCP 的 Tool 数量需连接上游后才知道，当前不展示为 0。"
                          : "该服务没有 Tool。"}
                      </Typography.Paragraph>
                    )}
                    <Flex gap={8}>
                      <Button size="small" icon={<SendOutlined />} onClick={() => openTrial(service)}>
                        试用
                      </Button>
                      <Button
                        size="small"
                        type="primary"
                        icon={busy === service.id ? <LoadingOutlined spin /> : subscribed ? <CheckCircleFilled /> : <KeyOutlined />}
                        loading={busy === service.id}
                        disabled={!selectedClientId || busy === service.id || subscribed}
                        onClick={() => void subscribe(service)}
                      >
                        {subscribed ? "已订阅" : "一键订阅"}
                      </Button>
                    </Flex>
                  </Flex>
                </Card>
              </List.Item>
            );
          }}
        />
      )}
      <Modal
        centered
        open={trialService !== null}
        title={trialService ? `试用 ${trialService.name}` : "试用"}
        onCancel={() => setTrialService(null)}
        footer={null}
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          临时 Key 只保存在当前页面内存，不会写入本地存储或服务端 usage 记录之外的字段。
        </Typography.Paragraph>
        <Form layout="vertical" preserve={false}>
          <Form.Item label="Gateway API Key" extra="临时">
            <Input.Password
              aria-label="Gateway API Key"
              value={apiKey}
              autoComplete="off"
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="mcp_..."
            />
          </Form.Item>
          <Form.Item label="Tool">
            {trialService?.toolsUnknown ? (
              <Input
                aria-label="Tool"
                value={toolName}
                onChange={(event) => setToolName(event.target.value)}
                placeholder="输入 Remote MCP Tool 名"
              />
            ) : (
              <Select
                aria-label="Tool"
                value={toolName || undefined}
                onChange={(value) => setToolName(value)}
                options={(trialService?.tools ?? []).map((tool) => ({ value: tool.name, label: tool.name }))}
                placeholder="选择 Tool"
              />
            )}
          </Form.Item>
          <Form.Item label="参数 JSON">
            <Input.TextArea
              aria-label="参数 JSON"
              value={trialArguments}
              onChange={(event) => setTrialArguments(event.target.value)}
              rows={5}
            />
          </Form.Item>
          <Button
            type="primary"
            block
            icon={busy === "trial" ? <LoadingOutlined spin /> : <SendOutlined />}
            loading={busy === "trial"}
            disabled={busy === "trial" || !apiKey.trim() || !toolName.trim()}
            onClick={() => void runTrial()}
          >
            调用 Tool
          </Button>
          {trialResult ? (
            <Typography.Paragraph code style={{ fontSize: 12, marginTop: 8 }}>
              {trialResult}
            </Typography.Paragraph>
          ) : null}
        </Form>
      </Modal>
    </Flex>
  );
}
