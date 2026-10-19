import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  Checkbox,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Select,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  CheckOutlined,
  CloseOutlined,
  DeleteOutlined,
  KeyOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
} from "../../lib/icons.js";
import { confirmAction } from "../../components/studio/confirmAction.js";
import {
  createApiKey,
  createClient,
  deleteGrant,
  listApiKeys,
  listAuditEvents,
  listBuilds,
  listClientQuotas,
  listClientUsage,
  listClients,
  listGrants,
  listVersions,
  revokeApiKey,
  upsertClientQuota,
  upsertGrant,
  type ApiClientRecord,
  type ApiKeyRecord,
  type AuditEventSummary,
  type BuildJobSummary,
  type ClientGrantRecord,
  type ClientQuotaRecord,
  type McpScope,
  type McpService,
  type UsageEventRecord,
  type UsageSummary,
} from "./api.js";
import {
  constrainGrantScopes,
  grantCapabilities,
  supportsGrantScope,
  type GrantCapabilities,
} from "./grantCapabilities.js";
import { AuditEventDetails } from "./AuditEventDetails.js";

export type McpManagementView =
  "services" | "marketplace" | "builds" | "clients" | "audit" | "sla" | "sandbox";

function messageFrom(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function formatDate(value: string | null): string {
  if (!value) return "从未";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function nameFilter(value: string[] | null): string {
  if (value === null) return "全部";
  return value.length === 0 ? "无" : value.join(", ");
}

function buildStatus(value: BuildJobSummary["status"]): "default" | "processing" | "success" | "error" {
  switch (value) {
    case "RUNNING":
      return "processing";
    case "SUCCEEDED":
      return "success";
    case "FAILED":
      return "error";
    default:
      return "default";
  }
}

function keyStatus(value: ApiKeyRecord["status"]): "success" | "default" {
  return value === "ACTIVE" ? "success" : "default";
}

function usageStatus(value: UsageEventRecord["status"]): "processing" | "success" | "error" {
  switch (value) {
    case "SUCCEEDED":
      return "success";
    case "FAILED":
      return "error";
    default:
      return "processing";
  }
}

function auditStatus(value: AuditEventSummary["outcome"]): "success" | "error" {
  return value === "SUCCEEDED" ? "success" : "error";
}

export function BuildsView() {
  const [builds, setBuilds] = useState<BuildJobSummary[]>([]);
  const [status, setStatus] = useState<"ALL" | BuildJobSummary["status"]>("ALL");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setBuilds(await listBuilds());
      setError("");
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => void load(), [load]);

  const visible = useMemo(
    () => builds.filter((item) => status === "ALL" || item.status === status),
    [builds, status],
  );

  const columns: ColumnsType<BuildJobSummary> = [
    {
      title: "服务 / 版本",
      key: "service",
      render: (_, item) => (
        <Flex vertical gap={0}>
          <Typography.Text strong>{item.serviceName}</Typography.Text>
          <Typography.Text type="secondary">v{item.versionNumber}</Typography.Text>
        </Flex>
      ),
    },
    {
      title: "类型",
      dataIndex: "kind",
      key: "kind",
      width: 110,
      render: (value: BuildJobSummary["kind"]) => <Tag>{value}</Tag>,
    },
    {
      title: "阶段",
      key: "stage",
      render: (_, item) => (
        <Flex vertical gap={0}>
          <Typography.Text>{item.stage}</Typography.Text>
          <Typography.Text type="secondary">
            {item.errorCode ?? `第 ${item.attempt} 次`}
          </Typography.Text>
        </Flex>
      ),
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 150,
      render: (value: BuildJobSummary["status"]) => (
        <Flex align="center" gap={6}>
          <Badge status={buildStatus(value)} />
          <Tag color={buildStatus(value)}>{value}</Tag>
        </Flex>
      ),
    },
    {
      title: "更新时间",
      dataIndex: "updatedAt",
      key: "updatedAt",
      render: (value: string) => (
        <Typography.Text type="secondary">{formatDate(value)}</Typography.Text>
      ),
    },
  ];

  return (
    <Flex vertical gap={12}>
      <Card size="small">
        <Flex justify="space-between" align="center" gap={8} wrap>
          <Flex align="center" gap={8}>
            <Typography.Text strong>构建任务</Typography.Text>
            <Tag>
              {visible.length} / {builds.length}
            </Tag>
          </Flex>
          <Flex align="center" gap={8}>
            <Select
              aria-label="状态"
              value={status}
              style={{ width: 120 }}
              onChange={(value: string) => setStatus(value as typeof status)}
              options={[
                { value: "ALL", label: "全部" },
                { value: "QUEUED", label: "排队中" },
                { value: "RUNNING", label: "执行中" },
                { value: "SUCCEEDED", label: "成功" },
                { value: "FAILED", label: "失败" },
              ]}
            />
            <Tooltip title="刷新">
              <Button
                type="text"
                icon={<ReloadOutlined />}
                aria-label="刷新"
                onClick={() => void load()}
              />
            </Tooltip>
          </Flex>
        </Flex>
      </Card>
      {error ? <Alert type="error" showIcon message={error} /> : null}
      {loading ? (
        <Card size="small">
          <Flex justify="center" style={{ padding: 24 }}>
            <Spin tip="正在读取构建任务" />
          </Flex>
        </Card>
      ) : visible.length === 0 ? (
        <Card size="small">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无构建记录" />
        </Card>
      ) : (
        <Table<BuildJobSummary>
          size="small"
          rowKey="id"
          columns={columns}
          dataSource={visible}
          pagination={{ pageSize: 20 }}
          scroll={{ x: 720 }}
        />
      )}
    </Flex>
  );
}

const scopes: Array<{ value: McpScope; label: string }> = [
  { value: "mcp:connect", label: "连接 Gateway" },
  { value: "tools:list", label: "列出 Tools" },
  { value: "tools:call", label: "调用 Tools" },
  { value: "prompts:list", label: "列出 Prompts" },
  { value: "prompts:get", label: "读取 Prompts" },
];

function GrantForm({
  services,
  initial,
  busy,
  onClose,
  onSubmit,
}: {
  services: McpService[];
  initial?: ClientGrantRecord;
  busy: boolean;
  onClose: () => void;
  onSubmit: (
    serviceId: string,
    input: { scopes: McpScope[]; toolNames: string[] | null; promptNames: string[] | null },
  ) => Promise<void>;
}) {
  const [serviceId, setServiceId] = useState(initial?.serviceId ?? services[0]?.id ?? "");
  const [selectedScopes, setSelectedScopes] = useState<Set<McpScope>>(
    () => new Set(initial?.scopes ?? ["mcp:connect"]),
  );
  const [allTools, setAllTools] = useState(initial ? initial.toolNames === null : true);
  const [allPrompts, setAllPrompts] = useState(initial ? initial.promptNames === null : true);
  const [toolNames, setToolNames] = useState(initial?.toolNames?.join(", ") ?? "");
  const [promptNames, setPromptNames] = useState(initial?.promptNames?.join(", ") ?? "");
  const [capabilities, setCapabilities] = useState<GrantCapabilities | null>(null);
  const [capabilityLoading, setCapabilityLoading] = useState(true);
  const [capabilityError, setCapabilityError] = useState("");

  useEffect(() => {
    const service = services.find((item) => item.id === serviceId);
    if (!service) {
      setCapabilities(null);
      setCapabilityLoading(false);
      return;
    }

    let cancelled = false;
    setCapabilities(null);
    setCapabilityError("");
    setCapabilityLoading(true);
    listVersions(service.id)
      .then((versions) => {
        if (cancelled) return;
        const next = grantCapabilities(service, versions);
        setCapabilities(next);
        setSelectedScopes((current) => new Set(constrainGrantScopes(current, next)));
        if (next.toolCount === 0) {
          setAllTools(false);
          setToolNames("");
        }
        if (next.promptCount === 0) {
          setAllPrompts(false);
          setPromptNames("");
        }
      })
      .catch((reason) => {
        if (!cancelled) setCapabilityError(messageFrom(reason));
      })
      .finally(() => {
        if (!cancelled) setCapabilityLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [serviceId, services]);

  const toggleScope = (scope: McpScope) => {
    setSelectedScopes((current) => {
      const next = new Set(current);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      if (scope === "tools:call" && !current.has(scope)) next.add("tools:list");
      if (scope === "prompts:get" && !current.has(scope)) next.add("prompts:list");
      if (scope === "tools:list" && current.has(scope)) next.delete("tools:call");
      if (scope === "prompts:list" && current.has(scope)) next.delete("prompts:get");
      next.add("mcp:connect");
      return next;
    });
  };

  const parseNames = (value: string): string[] => [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];

  const submitDisabled =
    busy || !serviceId || capabilityLoading || !capabilities || Boolean(capabilityError);

  return (
    <Form
      layout="vertical"
      onFinish={() => {
        if (!capabilities) return;
        const constrainedScopes = constrainGrantScopes(selectedScopes, capabilities);
        void onSubmit(serviceId, {
          scopes: constrainedScopes,
          toolNames: capabilities.toolCount === 0 ? [] : allTools ? null : parseNames(toolNames),
          promptNames:
            capabilities.promptCount === 0 ? [] : allPrompts ? null : parseNames(promptNames),
        });
      }}
    >
      <Form.Item label="服务">
        <Select
          aria-label="服务"
          value={serviceId || undefined}
          disabled={Boolean(initial)}
          placeholder="选择服务"
          onChange={(value: string) => {
            setServiceId(value);
            setSelectedScopes(new Set(["mcp:connect"]));
            setAllTools(false);
            setAllPrompts(false);
            setToolNames("");
            setPromptNames("");
          }}
          options={services.map((service) => ({ value: service.id, label: service.name }))}
        />
      </Form.Item>
      {capabilityLoading ? (
        <Flex align="center" gap={8} style={{ marginBottom: 12 }}>
          <Spin size="small" />
          <Typography.Text type="secondary">正在读取当前发布版本能力...</Typography.Text>
        </Flex>
      ) : null}
      {capabilityError ? (
        <Alert type="error" showIcon message={capabilityError} style={{ marginBottom: 12 }} />
      ) : null}
      {capabilities && !capabilityError ? (
        <Typography.Paragraph type="secondary">
          {capabilities.versionNumber === null
            ? "当前没有已发布版本"
            : `当前发布版本 v${capabilities.versionNumber} · ${capabilities.toolCount} Tools · ${capabilities.promptCount} Prompts`}
        </Typography.Paragraph>
      ) : null}
      <Form.Item label="Scopes">
        <Flex vertical gap={4}>
          {scopes.map((scope) => {
            const supported = capabilities
              ? supportsGrantScope(scope.value, capabilities)
              : scope.value === "mcp:connect";
            const disabled =
              scope.value === "mcp:connect" || capabilityLoading || !capabilities || !supported;
            return (
              <Checkbox
                key={scope.value}
                checked={selectedScopes.has(scope.value)}
                disabled={disabled}
                onChange={() => toggleScope(scope.value)}
              >
                {scope.label}
              </Checkbox>
            );
          })}
        </Flex>
      </Form.Item>
      <Flex gap={8}>
        <Form.Item label="Tool 白名单" style={{ flex: 1, marginBottom: 0 }}>
          <Flex vertical gap={8}>
            <Checkbox
              checked={allTools}
              disabled={capabilityLoading || !capabilities || capabilities.toolCount === 0}
              onChange={(event) => setAllTools(event.target.checked)}
            >
              全部
            </Checkbox>
            <Input
              aria-label="Tool 白名单"
              disabled={
                allTools || capabilityLoading || !capabilities || capabilities.toolCount === 0
              }
              value={toolNames}
              onChange={(event) => setToolNames(event.target.value)}
              placeholder="echo, search"
            />
          </Flex>
        </Form.Item>
        <Form.Item label="Prompt 白名单" style={{ flex: 1, marginBottom: 0 }}>
          <Flex vertical gap={8}>
            <Checkbox
              checked={allPrompts}
              disabled={capabilityLoading || !capabilities || capabilities.promptCount === 0}
              onChange={(event) => setAllPrompts(event.target.checked)}
            >
              全部
            </Checkbox>
            <Input
              aria-label="Prompt 白名单"
              disabled={
                allPrompts || capabilityLoading || !capabilities || capabilities.promptCount === 0
              }
              value={promptNames}
              onChange={(event) => setPromptNames(event.target.value)}
              placeholder="summary, rewrite"
            />
          </Flex>
        </Form.Item>
      </Flex>
      <Flex gap={8} justify="flex-end" style={{ marginTop: 16 }}>
        <Button onClick={onClose}>取消</Button>
        <Button
          type="primary"
          htmlType="submit"
          loading={busy}
          disabled={submitDisabled}
          icon={<SafetyCertificateOutlined />}
        >
          保存授权
        </Button>
      </Flex>
    </Form>
  );
}

export function ClientsView({ services }: { services: McpService[] }) {
  const { message } = App.useApp();
  const [clients, setClients] = useState<ApiClientRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [grants, setGrants] = useState<ClientGrantRecord[]>([]);
  const [quotas, setQuotas] = useState<ClientQuotaRecord[]>([]);
  const [usage, setUsage] = useState<{ events: UsageEventRecord[]; summary: UsageSummary }>({
    events: [],
    summary: { total: 0, reserved: 0, succeeded: 0, failed: 0 },
  });
  const [quotaServiceId, setQuotaServiceId] = useState<string>("");
  const [quotaQps, setQuotaQps] = useState("0");
  const [quotaDaily, setQuotaDaily] = useState("0");
  const [dialog, setDialog] = useState<"client" | "key" | "grant" | null>(null);
  const [editingGrant, setEditingGrant] = useState<ClientGrantRecord | undefined>();
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadClients = useCallback(async () => {
    setLoading(true);
    try {
      const next = await listClients();
      setClients(next);
      setSelectedId((current) => current ?? next[0]?.id ?? null);
      setError("");
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAccess = useCallback(async (clientId: string) => {
    try {
      const [nextKeys, nextGrants, nextQuotas, nextUsage] = await Promise.all([
        listApiKeys(clientId),
        listGrants(clientId),
        listClientQuotas(clientId),
        listClientUsage(clientId),
      ]);
      setKeys(nextKeys);
      setGrants(nextGrants);
      setQuotas(nextQuotas);
      setUsage(nextUsage);
      const global = nextQuotas.find((quota) => quota.serviceId === null);
      setQuotaQps(String(global?.qpsLimit ?? 0));
      setQuotaDaily(String(global?.dailyCallLimit ?? 0));
      setError("");
    } catch (reason) {
      setError(messageFrom(reason));
    }
  }, []);

  useEffect(() => void loadClients(), [loadClients]);
  useEffect(() => {
    if (selectedId) void loadAccess(selectedId);
    else {
      setKeys([]);
      setGrants([]);
      setQuotas([]);
      setUsage({ events: [], summary: { total: 0, reserved: 0, succeeded: 0, failed: 0 } });
      setQuotaServiceId("");
      setQuotaQps("0");
      setQuotaDaily("0");
    }
  }, [loadAccess, selectedId]);

  useEffect(() => {
    setQuotaServiceId("");
    setQuotaQps("0");
    setQuotaDaily("0");
  }, [selectedId]);

  const perform = async (success: string, action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      setNotice(success);
      message.success(success);
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setBusy(false);
    }
  };

  const client = clients.find((item) => item.id === selectedId) ?? null;
  const activeKeys = keys.filter((key) => key.status === "ACTIVE").length;

  const keyColumns: ColumnsType<ApiKeyRecord> = [
    {
      title: "Key ID",
      dataIndex: "id",
      key: "id",
      render: (value: string) => <Typography.Text code>{value.slice(0, 12)}</Typography.Text>,
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 130,
      render: (value: ApiKeyRecord["status"]) => (
        <Flex align="center" gap={6}>
          <Badge status={keyStatus(value)} />
          <Tag color={keyStatus(value)}>{value}</Tag>
        </Flex>
      ),
    },
    {
      title: "最近使用",
      dataIndex: "lastUsedAt",
      key: "lastUsedAt",
      render: (value: string | null) => (
        <Typography.Text type="secondary">{formatDate(value)}</Typography.Text>
      ),
    },
    {
      title: "过期时间",
      dataIndex: "expiresAt",
      key: "expiresAt",
      render: (value: string | null) => (
        <Typography.Text type="secondary">{formatDate(value)}</Typography.Text>
      ),
    },
    {
      title: "操作",
      key: "actions",
      width: 70,
      render: (_, record) =>
        record.status === "ACTIVE" && client ? (
          <Tooltip title="撤销 Key">
            <Button
              type="text"
              danger
              size="small"
              icon={<DeleteOutlined />}
              aria-label="撤销 Key"
              onClick={() =>
                confirmAction({
                  title: "撤销这个 API Key？",
                  content: "撤销后该 Key 立即失效，正在使用它的调用会失败，且不可恢复。",
                  okText: "撤销",
                  danger: true,
                  onOk: () =>
                    void perform("API Key 已撤销", async () => {
                      await revokeApiKey(client.id, record.id);
                      await loadAccess(client.id);
                    }),
                })
              }
            />
          </Tooltip>
        ) : null,
    },
  ];

  const usageColumns: ColumnsType<UsageEventRecord> = [
    {
      title: "时间",
      dataIndex: "createdAt",
      key: "createdAt",
      render: (value: string) => (
        <Typography.Text type="secondary">{formatDate(value)}</Typography.Text>
      ),
    },
    {
      title: "服务",
      dataIndex: "serviceId",
      key: "serviceId",
      render: (value: string) => (
        <Typography.Text code>
          {services.find((service) => service.id === value)?.name ?? value.slice(0, 8)}
        </Typography.Text>
      ),
    },
    {
      title: "Tool",
      dataIndex: "toolName",
      key: "toolName",
      render: (value: string) => <Typography.Text code>{value}</Typography.Text>,
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 140,
      render: (value: UsageEventRecord["status"]) => (
        <Flex align="center" gap={6}>
          <Badge status={usageStatus(value)} />
          <Tag color={usageStatus(value)}>{value}</Tag>
        </Flex>
      ),
    },
    {
      title: "耗时",
      dataIndex: "durationMs",
      key: "durationMs",
      width: 110,
      render: (value: number | null) => (
        <Typography.Text type="secondary">{value === null ? "—" : `${value} ms`}</Typography.Text>
      ),
    },
  ];

  return (
    <Flex vertical gap={12}>
      <Card size="small">
        <Flex justify="space-between" align="center" gap={8} wrap>
          <Flex align="center" gap={8}>
            <Typography.Text strong>API 客户端</Typography.Text>
            <Tag>{clients.length} 个客户端</Tag>
          </Flex>
          <Flex gap={8}>
            <Tooltip title="刷新">
              <Button
                type="text"
                icon={<ReloadOutlined />}
                aria-label="刷新"
                onClick={() => void loadClients()}
              />
            </Tooltip>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setDialog("client")}>
              新建客户端
            </Button>
          </Flex>
        </Flex>
      </Card>
      {error ? <Alert type="error" showIcon message={error} /> : null}
      {notice ? <Alert type="success" showIcon closable message={notice} /> : null}
      {loading ? (
        <Card size="small">
          <Flex justify="center" style={{ padding: 24 }}>
            <Spin tip="正在读取客户端" />
          </Flex>
        </Card>
      ) : clients.length === 0 ? (
        <Card size="small">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无 API 客户端" />
        </Card>
      ) : (
        <Flex gap={12} align="flex-start">
          <Card
            size="small"
            title="客户端"
            extra={<Tag>{clients.length}</Tag>}
            style={{ width: 280, flex: "0 0 auto" }}
            styles={{ body: { padding: 8 } }}
          >
            <List
              size="small"
              rowKey="id"
              dataSource={clients}
              renderItem={(item) => (
                <List.Item
                  style={{ cursor: "pointer", borderRadius: 8, padding: "8px 12px" }}
                  onClick={() => setSelectedId(item.id)}
                >
                  <Flex justify="space-between" align="center" style={{ width: "100%" }} gap={8}>
                    <Flex vertical gap={0} style={{ minWidth: 0 }}>
                      <Typography.Text strong ellipsis>
                        {item.name}
                      </Typography.Text>
                      <Typography.Text type="secondary">{item.status}</Typography.Text>
                    </Flex>
                    <Flex align="center" gap={4}>
                      {item.id === selectedId ? <Tag color="blue">当前</Tag> : null}
                      <Typography.Text type="secondary" code>
                        {item.id.slice(0, 8)}
                      </Typography.Text>
                    </Flex>
                  </Flex>
                </List.Item>
              )}
            />
          </Card>
          {client ? (
            <Flex vertical gap={12} style={{ flex: 1, minWidth: 0 }}>
              <Card
                size="small"
                title="API Keys"
                extra={
                  <Flex gap={8} align="center">
                    <Tag>{activeKeys} 个有效 Key</Tag>
                    <Button size="small" icon={<KeyOutlined />} onClick={() => setDialog("key")}>
                      签发 Key
                    </Button>
                  </Flex>
                }
              >
                <Table<ApiKeyRecord>
                  size="small"
                  rowKey="id"
                  columns={keyColumns}
                  dataSource={keys}
                  pagination={keys.length > 10 ? { pageSize: 10, showSizeChanger: false } : false}
                  locale={{
                    emptyText: (
                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无 API Key" />
                    ),
                  }}
                />
              </Card>
              <Card
                size="small"
                title="配额与用量"
                extra={
                  <Tag>
                    今日 {usage.summary.total} 次 · 成功 {usage.summary.succeeded} · 失败{" "}
                    {usage.summary.failed}
                  </Tag>
                }
              >
                <Form layout="vertical">
                  <Flex gap={8} wrap>
                    <Form.Item label="作用范围" style={{ flex: "2 1 200px", minWidth: 180 }}>
                      <Select
                        aria-label="作用范围"
                        value={quotaServiceId}
                        onChange={(value: string) => {
                          setQuotaServiceId(value);
                          const selected = quotas.find(
                            (quota) => quota.serviceId === (value || null),
                          );
                          setQuotaQps(String(selected?.qpsLimit ?? 0));
                          setQuotaDaily(String(selected?.dailyCallLimit ?? 0));
                        }}
                        options={[
                          { value: "", label: "客户端全局 QPS" },
                          ...services.map((service) => ({
                            value: service.id,
                            label: `${service.name} · 日调用`,
                          })),
                        ]}
                      />
                    </Form.Item>
                    <Form.Item label="QPS 上限" style={{ flex: "1 1 120px", minWidth: 120 }}>
                      <InputNumber
                        aria-label="QPS 上限"
                        min={0}
                        style={{ width: "100%" }}
                        value={Number(quotaQps) || 0}
                        onChange={(value) => setQuotaQps(String(value ?? 0))}
                      />
                    </Form.Item>
                    <Form.Item label="日调用上限" style={{ flex: "1 1 120px", minWidth: 120 }}>
                      <InputNumber
                        aria-label="日调用上限"
                        min={0}
                        style={{ width: "100%" }}
                        value={Number(quotaDaily) || 0}
                        onChange={(value) => setQuotaDaily(String(value ?? 0))}
                      />
                    </Form.Item>
                  </Flex>
                  <Flex gap={8} wrap>
                    <Button
                      onClick={() => {
                        const selected = quotas.find(
                          (quota) => quota.serviceId === (quotaServiceId || null),
                        );
                        setQuotaQps(String(selected?.qpsLimit ?? 0));
                        setQuotaDaily(String(selected?.dailyCallLimit ?? 0));
                      }}
                    >
                      读取当前值
                    </Button>
                    <Button
                      type="primary"
                      loading={busy}
                      onClick={() =>
                        void perform("配额已保存", async () => {
                          await upsertClientQuota(client.id, {
                            serviceId: quotaServiceId || null,
                            qpsLimit: Number(quotaQps) || 0,
                            dailyCallLimit: Number(quotaDaily) || 0,
                          });
                          await loadAccess(client.id);
                        })
                      }
                    >
                      保存配额
                    </Button>
                  </Flex>
                </Form>
                <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
                  0 表示不限；QPS 为客户端全局，日调用上限按 client + service 生效。
                </Typography.Paragraph>
                <Table<UsageEventRecord>
                  size="small"
                  rowKey="id"
                  aria-label="最近用量"
                  columns={usageColumns}
                  dataSource={usage.events.slice(0, 20)}
                  pagination={false}
                  scroll={{ x: 640 }}
                  locale={{
                    emptyText: (
                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无用量记录" />
                    ),
                  }}
                />
              </Card>
              <Card
                size="small"
                title="服务授权"
                extra={
                  <Flex gap={8} align="center">
                    <Tag>{grants.length} 条 Grant</Tag>
                    <Button
                      size="small"
                      icon={<PlusOutlined />}
                      onClick={() => {
                        setEditingGrant(undefined);
                        setDialog("grant");
                      }}
                    >
                      添加授权
                    </Button>
                  </Flex>
                }
              >
                {grants.length === 0 ? (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无服务授权" />
                ) : (
                  <List
                    size="small"
                    rowKey="id"
                    dataSource={grants}
                    renderItem={(grant) => (
                      <List.Item
                        actions={[
                          <Button
                            key="edit"
                            type="link"
                            size="small"
                            onClick={() => {
                              setEditingGrant(grant);
                              setDialog("grant");
                            }}
                          >
                            编辑
                          </Button>,
                          <Tooltip key="delete" title="删除授权">
                            <Button
                              type="text"
                              danger
                              size="small"
                              icon={<DeleteOutlined />}
                              aria-label="删除授权"
                              onClick={() =>
                                confirmAction({
                                  title: "删除这条服务授权？",
                                  content:
                                    "删除后该客户端将无法再调用此服务的 Tools 与 Prompts，且不可恢复。",
                                  okText: "删除",
                                  danger: true,
                                  onOk: () =>
                                    void perform("服务授权已删除", async () => {
                                      await deleteGrant(client.id, grant.serviceId);
                                      await loadAccess(client.id);
                                    }),
                                })
                              }
                            />
                          </Tooltip>,
                        ]}
                      >
                        <List.Item.Meta
                          title={
                            services.find((item) => item.id === grant.serviceId)?.name ??
                            grant.serviceId
                          }
                          description={
                            <Flex vertical gap={2}>
                              <Typography.Text type="secondary">
                                {grant.scopes.join(" · ")}
                              </Typography.Text>
                              <Typography.Text type="secondary">
                                Tools: {nameFilter(grant.toolNames)}
                              </Typography.Text>
                              <Typography.Text type="secondary">
                                Prompts: {nameFilter(grant.promptNames)}
                              </Typography.Text>
                            </Flex>
                          }
                        />
                      </List.Item>
                    )}
                  />
                )}
              </Card>
            </Flex>
          ) : (
            <Card size="small" style={{ flex: 1 }}>
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="请选择左侧客户端查看详情"
              />
            </Card>
          )}
        </Flex>
      )}

      {dialog === "client" ? (
        <SimpleFormDialog
          title="新建 API 客户端"
          label="客户端名称"
          inputName="name"
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={async (value) =>
            perform("客户端已创建", async () => {
              const created = await createClient(value);
              setClients((items) => [created, ...items]);
              setSelectedId(created.id);
              setDialog(null);
            })
          }
        />
      ) : null}
      {dialog === "key" && client ? (
        <KeyDialog
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={async (expiresAt) =>
            perform("API Key 已签发", async () => {
              const issued = await createApiKey(client.id, expiresAt);
              setRawKey(issued.rawKey);
              setDialog(null);
              await loadAccess(client.id);
            })
          }
        />
      ) : null}
      {dialog === "grant" && client ? (
        <Modal
          centered
          open
          title={editingGrant ? "编辑服务授权" : "添加服务授权"}
          closeIcon={<CloseOutlined />}
          onCancel={() => setDialog(null)}
          footer={null}
        >
          <GrantForm
            services={services}
            initial={editingGrant}
            busy={busy}
            onClose={() => setDialog(null)}
            onSubmit={async (serviceId, input) =>
              perform("服务授权已保存", async () => {
                await upsertGrant(client.id, serviceId, input);
                setDialog(null);
                await loadAccess(client.id);
              })
            }
          />
        </Modal>
      ) : null}
      <Modal
        centered
        open={rawKey !== null}
        title="API Key 已创建"
        closeIcon={<CloseOutlined />}
        onCancel={() => setRawKey(null)}
        footer={
          <Flex justify="flex-end">
            <Button type="primary" onClick={() => setRawKey(null)}>
              完成
            </Button>
          </Flex>
        }
      >
        <Typography.Paragraph type="secondary">原始 Key 仅展示一次，请立即复制保存。</Typography.Paragraph>
        {rawKey ? (
          <Typography.Paragraph code copyable={{ text: rawKey }}>
            {rawKey}
          </Typography.Paragraph>
        ) : null}
      </Modal>
    </Flex>
  );
}

function SimpleFormDialog({
  title,
  label,
  inputName,
  busy,
  onClose,
  onSubmit,
}: {
  title: string;
  label: string;
  inputName: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (value: string) => Promise<void>;
}) {
  const [form] = Form.useForm();
  return (
    <Modal
      centered
      open
      title={title}
      closeIcon={<CloseOutlined />}
      onCancel={onClose}
      footer={null}
    >
      <Form
        form={form}
        layout="vertical"
        preserve={false}
        onFinish={(values: Record<string, unknown>) => {
          const value = String(values[inputName] ?? "").trim();
          if (value) void onSubmit(value);
        }}
      >
        <Form.Item
          label={label}
          name={inputName}
          rules={[{ required: true, message: `请输入${label}` }]}
        >
          <Input autoFocus />
        </Form.Item>
        <Flex gap={8} justify="flex-end">
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" htmlType="submit" loading={busy} icon={<CheckOutlined />}>
            创建
          </Button>
        </Flex>
      </Form>
    </Modal>
  );
}

function KeyDialog({
  busy,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  onClose: () => void;
  onSubmit: (expiresAt: string | null) => Promise<void>;
}) {
  const [form] = Form.useForm();
  return (
    <Modal
      centered
      open
      title="签发 API Key"
      closeIcon={<CloseOutlined />}
      onCancel={onClose}
      footer={null}
    >
      <Form
        form={form}
        layout="vertical"
        preserve={false}
        onFinish={(values: Record<string, unknown>) => {
          const raw = String(values["expiresAt"] ?? "");
          void onSubmit(raw ? new Date(raw).toISOString() : null);
        }}
      >
        <Form.Item label="过期时间" name="expiresAt" extra="可选，不填表示不过期">
          <Input type="datetime-local" />
        </Form.Item>
        <Flex gap={8} justify="flex-end">
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" htmlType="submit" loading={busy} icon={<KeyOutlined />}>
            签发
          </Button>
        </Flex>
      </Form>
    </Modal>
  );
}

export function AuditView() {
  const [events, setEvents] = useState<AuditEventSummary[]>([]);
  const [outcome, setOutcome] = useState<"ALL" | AuditEventSummary["outcome"]>("ALL");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [action, setAction] = useState("");
  const [appliedAction, setAppliedAction] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEvents(
        await listAuditEvents({
          ...(outcome === "ALL" ? {} : { outcome }),
          ...(appliedAction ? { action: appliedAction } : {}),
        }),
      );
      setError("");
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setLoading(false);
    }
  }, [appliedAction, outcome]);

  useEffect(() => void load(), [load]);

  const applySearch = (value: string) => {
    const next = value.trim();
    if (next === appliedAction) void load();
    else setAppliedAction(next);
  };

  const columns: ColumnsType<AuditEventSummary> = [
    {
      title: "时间",
      dataIndex: "createdAt",
      key: "createdAt",
      render: (value: string) => (
        <Typography.Text type="secondary">{formatDate(value)}</Typography.Text>
      ),
    },
    {
      title: "操作者",
      key: "actor",
      render: (_, item) => (
        <Flex vertical gap={0}>
          <Typography.Text strong>{item.actorId}</Typography.Text>
          <Typography.Text type="secondary">{item.actorRole}</Typography.Text>
        </Flex>
      ),
    },
    {
      title: "动作",
      dataIndex: "action",
      key: "action",
      render: (value: string) => <Typography.Text code>{value}</Typography.Text>,
    },
    {
      title: "目标",
      key: "target",
      render: (_, item) => (
        <Flex vertical gap={0}>
          <Typography.Text strong title={item.target} ellipsis style={{ maxWidth: 220 }}>
            {item.target}
          </Typography.Text>
          <Typography.Text type="secondary">
            {item.requestId} · {item.durationMs}ms
          </Typography.Text>
        </Flex>
      ),
    },
    {
      title: "结果",
      dataIndex: "outcome",
      key: "outcome",
      width: 170,
      render: (value: AuditEventSummary["outcome"], item) => (
        <Flex vertical gap={2}>
          <Flex align="center" gap={6}>
            <Badge status={auditStatus(value)} />
            <Tag color={auditStatus(value)}>{value}</Tag>
          </Flex>
          <Typography.Text type="secondary">HTTP {item.statusCode}</Typography.Text>
        </Flex>
      ),
    },
    {
      title: "操作",
      key: "actions",
      width: 110,
      render: (_, item) => (
        <Button type="link" size="small" onClick={() => setSelectedId(item.id)}>
          查看详情
        </Button>
      ),
    },
  ];

  return (
    <Flex vertical gap={12}>
      <Card size="small">
        <Flex justify="space-between" align="center" gap={8} wrap>
          <Flex align="center" gap={8}>
            <Typography.Text strong>审计事件</Typography.Text>
            <Tag>{events.length} 条最近记录</Tag>
          </Flex>
          <Flex align="center" gap={8} wrap>
            <Select
              aria-label="结果"
              value={outcome}
              style={{ width: 110 }}
              onChange={(value: string) => setOutcome(value as typeof outcome)}
              options={[
                { value: "ALL", label: "全部" },
                { value: "SUCCEEDED", label: "成功" },
                { value: "FAILED", label: "失败" },
              ]}
            />
            <Input.Search
              aria-label="动作"
              value={action}
              onChange={(event) => setAction(event.target.value)}
              onSearch={applySearch}
              placeholder="例如 service.publish"
              allowClear
              style={{ width: 220 }}
            />
            <Tooltip title="刷新">
              <Button
                type="text"
                icon={<ReloadOutlined />}
                aria-label="刷新"
                onClick={() => void load()}
              />
            </Tooltip>
          </Flex>
        </Flex>
      </Card>
      {error ? <Alert type="error" showIcon message={error} /> : null}
      {loading ? (
        <Card size="small">
          <Flex justify="center" style={{ padding: 24 }}>
            <Spin tip="正在读取审计事件" />
          </Flex>
        </Card>
      ) : events.length === 0 ? (
        <Card size="small">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的审计事件" />
        </Card>
      ) : (
        <Table<AuditEventSummary>
          size="small"
          rowKey="id"
          columns={columns}
          dataSource={events}
          pagination={{ pageSize: 20 }}
          scroll={{ x: 900 }}
        />
      )}
      <Modal
        centered
        open={selectedId !== null}
        title="审计事件详情"
        closeIcon={<CloseOutlined />}
        onCancel={() => setSelectedId(null)}
        footer={null}
        width={720}
      >
        {selectedId ? <AuditEventDetails key={selectedId} eventId={selectedId} /> : null}
      </Modal>
    </Flex>
  );
}

