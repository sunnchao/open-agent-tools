import { useEffect, useState } from "react";
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  Empty,
  Flex,
  Form,
  Input,
  Menu,
  Modal,
  Popconfirm,
  Select,
  Spin,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
  StarOutlined,
} from "../../lib/icons.js";
import {
  fetchProviderModels,
  fetchProviders,
  probeProviderModels,
  removeProvider,
  saveProvider,
  setDefaultProvider,
  type ProviderFormat,
  type ProviderMetadata,
} from "../providers/api.js";
import {
  getStudioApiToken,
  getWorkspaceId,
  setStudioApiToken,
  setWorkspaceId,
  studioFetch,
} from "../../lib/client.js";
import {
  fetchUsage,
  fetchWorkspaces,
  createWorkspace,
  type UsageSummary,
  type Workspace,
} from "../workspaces/api.js";
import { PROVIDER_FORMATS, PROVIDER_FORMAT_LABELS } from "../providers/api.js";
import { ImChannelsSection } from "../im/ImChannelsWorkspace.js";
import { SchemaSourcesSection } from "./SchemaSourcesSection.js";
import { McpGatewaySection } from "./McpGatewaySection.js";
import { PublishedAppsSection } from "../apps/PublishedAppsSection.js";
import { BrandingSection } from "../branding/BrandingSection.js";
import { downloadExport, usageExportPath, type ExportFormat } from "../observatory/export.js";

interface IdentityStatus {
  configError?: string | null;
  enabled: boolean;
  provider: "oidc" | "deployment-token" | "none";
  mode: "oidc" | "deployment-token" | "open";
  issuer: string | null;
  audience: string | null;
  groupsClaim: string;
  rolesClaim: string;
  adminRoles: string[];
  ldap: {
    enabled: boolean;
    mode: "ldap_trusted_gateway";
    gatewayConfigured: boolean;
    passwordBinding: false;
    assertionConfigured: boolean;
    assertionKeyId: string | null;
    assertionIssuer: string | null;
    assertionAudience: string | null;
    identityMode: "optional" | "required" | "required_for_groups";
    readiness: "not_configured" | "assertion_missing" | "invalid_config" | "ready";
    configError: string | null;
    summary: string;
  };
  deploymentTokenFallback: boolean;
}

const identityProviderLabel: Record<IdentityStatus["provider"], string> = {
  oidc: "OIDC",
  "deployment-token": "部署 Token",
  none: "未启用",
};

const ldapReadinessLabel: Record<IdentityStatus["ldap"]["readiness"], string> = {
  not_configured: "未配置网关",
  assertion_missing: "断言配置不完整",
  invalid_config: "网关配置无效",
  ready: "网关链路就绪",
};

async function fetchIdentityStatus(): Promise<IdentityStatus> {
  const response = await studioFetch("/api/admin/identity/status");
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  return ((await response.json()) as { identity: IdentityStatus }).identity;
}

type SettingsSection =
  "providers" | "schema-sources" | "mcp-gateway" | "im" | "apps" | "identity" | "branding";

const sectionCopy: Record<SettingsSection, { title: string; subtitle: string }> = {
  providers: { title: "模型 Provider", subtitle: "集中管理模型服务、接入协议和路由。" },
  "schema-sources": { title: "Schema 数据源", subtitle: "管理问数数据库、采集范围与默认路由。" },
  "mcp-gateway": {
    title: "MCP Gateway",
    subtitle: "配置工作流和对话使用的 Gateway 地址与 API Key。",
  },
  im: { title: "IM 渠道", subtitle: "接入飞书 / 钉钉机器人，配置知识库绑定与群聊响应规则。" },
  apps: { title: "员工入口", subtitle: "把知识库与工具打包成独立问答入口，员工打开链接即可使用。" },
  identity: {
    title: "企业身份",
    subtitle: "查看 OIDC / LDAP 网关接入状态；密钥只在服务端配置。",
  },
  branding: {
    title: "品牌与渠道",
    subtitle: "替换产品名、配色与页脚，写入渠道分销码。",
  },
};

const sectionMenuItems = [
  { key: "providers", label: "01 · 模型 Provider" },
  { key: "schema-sources", label: "02 · Schema 数据源" },
  { key: "mcp-gateway", label: "03 · MCP Gateway" },
  { key: "im", label: "04 · IM 渠道" },
  { key: "apps", label: "05 · 员工入口" },
  { key: "identity", label: "06 · 企业身份" },
  { key: "branding", label: "07 · 品牌与渠道" },
];

function initialSection(): SettingsSection {
  const stored = sessionStorage.getItem("open-agent-tools.settings-section");
  return stored === "schema-sources" ||
    stored === "mcp-gateway" ||
    stored === "im" ||
    stored === "apps" ||
    stored === "identity" ||
    stored === "branding"
    ? stored
    : "providers";
}

type Draft = {
  id?: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  enabled: boolean;
  format: ProviderFormat;
};
const emptyDraft = (): Draft => ({
  name: "",
  baseUrl: "",
  apiKey: "",
  models: [],
  enabled: true,
  format: "openai-chat",
});

interface IdentityRow {
  key: string;
  item: string;
  value: string;
  note: string;
}

function IdentitySection(props: {
  status: IdentityStatus | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  const { status, loading, error } = props;
  const rows: IdentityRow[] = status
    ? [
        {
          key: "provider",
          item: "Studio 身份提供商",
          value: identityProviderLabel[status.provider],
          note: "OIDC 优先；部署 Token 仅作显式兼容回退。",
        },
        {
          key: "issuer",
          item: "Issuer / Audience",
          value: `${status.issuer ?? "未配置"} / ${status.audience ?? "未配置"}`,
          note: "服务端校验 JWT 的签发方与受众，不接受前端传入。",
        },
        {
          key: "claims",
          item: "组 / 角色 Claim",
          value: `${status.groupsClaim} / ${status.rolesClaim}`,
          note: `管理员角色：${status.adminRoles.join(", ") || "未配置"}`,
        },
        {
          key: "ldap",
          item: "LDAP 网关",
          value: ldapReadinessLabel[status.ldap.readiness],
          note: status.ldap.summary,
        },
        {
          key: "hmac",
          item: "LDAP → HMAC 断言",
          value: `${status.ldap.assertionKeyId ?? "未配置 Key ID"} / ${status.ldap.identityMode}`,
          note: `${status.ldap.assertionIssuer ?? "未配置 Issuer"} / ${status.ldap.assertionAudience ?? "未配置 Audience"}。HMAC secret 仅保留在服务端与网关。`,
        },
        {
          key: "password",
          item: "密码处理",
          value: "不接收",
          note: "Agent Server 不在请求中 bind LDAP，不保存 LDAP 密码或 OIDC client secret。",
        },
      ]
    : [];
  const columns: ColumnsType<IdentityRow> = [
    { title: "项目", dataIndex: "item", key: "item", render: (value: string) => <Typography.Text strong>{value}</Typography.Text> },
    {
      title: "当前值",
      dataIndex: "value",
      key: "value",
      render: (value: string, record: IdentityRow) =>
        record.key === "provider" || record.key === "ldap" ? (
          <Badge
            status={
              (record.key === "provider" && status?.enabled) ||
              (record.key === "ldap" && status?.ldap.readiness === "ready")
                ? "success"
                : "default"
            }
            text={value}
          />
        ) : record.key === "password" ? (
          <Tag>{value}</Tag>
        ) : (
          <Typography.Text code style={{ fontSize: 12 }}>{value}</Typography.Text>
        ),
    },
    { title: "说明", dataIndex: "note", key: "note", render: (value: string) => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{value}</Typography.Text> },
  ];
  return (
    <Flex vertical gap={12}>
      {error ? <Alert type="error" showIcon message={error} /> : null}
      <Flex align="flex-start" justify="space-between" gap={12}>
        <Flex vertical gap={2}>
          <Typography.Text type="secondary" style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2 }}>
            ENTERPRISE IDENTITY
          </Typography.Text>
          <Typography.Title level={5} style={{ margin: 0 }}>
            企业身份接入
          </Typography.Title>
        </Flex>
        <Button icon={<ReloadOutlined spin={loading} />} disabled={loading} onClick={props.onRefresh}>
          刷新状态
        </Button>
      </Flex>
      {status?.configError ? (
        <Alert
          type="error"
          showIcon
          message={`身份配置未生效：${status.configError}。受保护接口当前拒绝访问，请修正环境变量后重启服务。`}
        />
      ) : null}
      {status ? (
        <Card size="small" styles={{ body: { padding: 0 } }}>
          <Table<IdentityRow>
            size="small"
            rowKey="key"
            columns={columns}
            dataSource={rows}
            pagination={false}
            loading={loading}
            scroll={{ x: "max-content" }}
          />
        </Card>
      ) : (
        <Card size="small">
          {loading ? (
            <Flex justify="center" style={{ padding: 24 }}><Spin aria-label="正在读取身份接入状态" /></Flex>
          ) : (
            <Empty description="暂无身份接入状态。" />
          )}
        </Card>
      )}
      {status ? (
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          当前配置：
          {status.ldap.gatewayConfigured ? "已配置可信网关入口；" : "未配置可信网关入口；"}
          {status.deploymentTokenFallback ? "部署 Token 回退已启用。" : "未启用部署 Token 回退。"}
        </Typography.Paragraph>
      ) : null}
    </Flex>
  );
}

export function SettingsWorkspace() {
  const { message } = App.useApp();
  const [providers, setProviders] = useState<ProviderMetadata[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [defaultingId, setDefaultingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<SettingsSection>(initialSection);
  const [studioToken, setStudioToken] = useState(() => getStudioApiToken());
  const [tokenSaved, setTokenSaved] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState(() => getWorkspaceId());
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [usageAll, setUsageAll] = useState(false);
  const [usageExporting, setUsageExporting] = useState<ExportFormat | null>(null);
  const [usageExportError, setUsageExportError] = useState<string | null>(null);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [identityStatus, setIdentityStatus] = useState<IdentityStatus | null>(null);
  const [identityLoading, setIdentityLoading] = useState(false);
  const [identityError, setIdentityError] = useState<string | null>(null);

  const selectSection = (section: SettingsSection) => {
    sessionStorage.setItem("open-agent-tools.settings-section", section);
    setActiveSection(section);
  };

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      setProviders(await fetchProviders({ includeDisabled: true }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Provider 加载失败");
    } finally {
      setLoading(false);
    }
  };

  // workspace 与用量相互独立：任一失败不应影响另一处展示。
  const refreshWorkspaces = async () => {
    setWorkspaceError(null);
    try {
      setWorkspaces(await fetchWorkspaces());
    } catch (reason) {
      setWorkspaceError(reason instanceof Error ? reason.message : "工作空间加载失败");
    }
  };

  const refreshUsage = async (all: boolean) => {
    try {
      setUsage(await fetchUsage({ days: 30, all }));
    } catch {
      setUsage(null);
    }
  };

  // 用量明细导出：带当前空间范围，通过 studioFetch 携带鉴权头后保存为文件。
  const exportUsage = async (format: ExportFormat) => {
    if (usageExporting) return;
    setUsageExporting(format);
    setUsageExportError(null);
    try {
      await downloadExport(
        usageExportPath({ days: 30, all: usageAll }, format),
        `usage-events.${format}`,
      );
      void message.success("用量明细已导出");
    } catch (reason) {
      setUsageExportError(reason instanceof Error ? reason.message : "用量导出失败");
    } finally {
      setUsageExporting(null);
    }
  };

  const refreshIdentity = async () => {
    setIdentityLoading(true);
    setIdentityError(null);
    try {
      setIdentityStatus(await fetchIdentityStatus());
    } catch (reason) {
      setIdentityError(reason instanceof Error ? reason.message : "身份接入状态加载失败");
    } finally {
      setIdentityLoading(false);
    }
  };

  // 首次加载：Provider、工作空间、用量各拉一次；用量切换范围时单独重取，不连带刷新 Provider。
  useEffect(() => {
    void refresh();
    void refreshWorkspaces();
    void refreshUsage(false);
    void refreshIdentity();
  }, []);

  const submit = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await saveProvider(draft);
      setDraft(null);
      await refresh();
      void message.success(`已保存 Provider「${saved.name}」`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Provider 保存失败");
    } finally {
      setSaving(false);
    }
  };

  const edit = (provider: ProviderMetadata) =>
    setDraft({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: "",
      models: provider.models,
      enabled: provider.enabled,
      format: provider.format,
    });

  const makeDefault = async (provider: ProviderMetadata) => {
    setDefaultingId(provider.id);
    setError(null);
    try {
      await setDefaultProvider(provider.id);
      await refresh();
      void message.success(`已将「${provider.name}」设为默认`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "设置默认 Provider 失败");
    } finally {
      setDefaultingId(null);
    }
  };

  const remove = async (provider: ProviderMetadata) => {
    setError(null);
    try {
      await removeProvider(provider.id);
      await refresh();
      void message.success(`Provider「${provider.name}」已删除`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除失败");
    }
  };

  const providerColumns: ColumnsType<ProviderMetadata> = [
    {
      title: "名称",
      dataIndex: "name",
      key: "name",
      render: (_: unknown, record: ProviderMetadata) => (
        <Flex gap={8} align="center">
          <Badge status={record.enabled ? "success" : "default"} />
          <Typography.Text strong>{record.name}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{record.id}</Typography.Text>
        </Flex>
      ),
    },
    {
      title: "Base URL",
      dataIndex: "baseUrl",
      key: "baseUrl",
      render: (value: string) => (
        <Typography.Text code ellipsis style={{ maxWidth: 200, fontSize: 12 }} title={value}>
          {value}
        </Typography.Text>
      ),
    },
    { title: "API Key", dataIndex: "apiKeyMasked", key: "apiKeyMasked", render: (value: string | null) => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{value ?? "未配置"}</Typography.Text> },
    {
      title: "格式",
      dataIndex: "format",
      key: "format",
      render: (value: ProviderFormat) => <Tag>{PROVIDER_FORMAT_LABELS[value]}</Tag>,
    },
    {
      title: "模型",
      dataIndex: "models",
      key: "models",
      render: (value: string[]) => <Tag>{value.length}</Tag>,
    },
    {
      title: "状态",
      dataIndex: "enabled",
      key: "enabled",
      render: (value: boolean) => <Badge status={value ? "success" : "default"} text={value ? "启用" : "停用"} />,
    },
    {
      title: "默认路由",
      dataIndex: "isDefault",
      key: "isDefault",
      render: (_: unknown, record: ProviderMetadata) =>
        record.isDefault ? (
          <Tag>DEFAULT</Tag>
        ) : (
          <Button
            type="text"
            size="small"
            icon={<StarOutlined spin={defaultingId === record.id} />}
            disabled={!record.enabled || defaultingId !== null}
            onClick={() => void makeDefault(record)}
            aria-label={record.enabled ? `设 ${record.name} 为默认` : "请先启用 Provider"}
          >
            {defaultingId === record.id ? "设置中" : "设为默认"}
          </Button>
        ),
    },
    {
      title: "操作",
      key: "actions",
      fixed: "right",
      width: 110,
      render: (_: unknown, record: ProviderMetadata) => (
        <Flex gap={4}>
          <Tooltip title="编辑">
            <Button type="text" icon={<EditOutlined />} aria-label={`编辑 ${record.name}`} onClick={() => edit(record)} />
          </Tooltip>
          {record.isDefault ? null : (
            <Popconfirm
              title={`删除 ${record.name}？`}
              description="该 Provider 的模型路由将一并清理，该操作不可恢复。"
              okText="确认删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => void remove(record)}
            >
              <Tooltip title="删除">
                <Button type="text" danger icon={<DeleteOutlined />} aria-label={`删除 ${record.name}`} />
              </Tooltip>
            </Popconfirm>
          )}
        </Flex>
      ),
    },
  ];

  const usageColumns: ColumnsType<UsageSummary["byModel"][number]> = [
    {
      title: "模型",
      dataIndex: "model",
      key: "model",
      render: (value: string) => <Typography.Text code style={{ fontSize: 12 }}>{value}</Typography.Text>,
    },
    { title: "模型请求", dataIndex: "requests", key: "requests" },
    { title: "输入 tokens", dataIndex: "inputTokens", key: "inputTokens", render: (value: number) => value.toLocaleString() },
    { title: "输出 tokens", dataIndex: "outputTokens", key: "outputTokens", render: (value: number) => value.toLocaleString() },
  ];
  const sourceLabels: Record<UsageSummary["bySource"][number]["source"], string> = {
    web_chat: "Web Chat",
    app_chat: "Web 发布应用",
    sql_query: "SQL 问数",
    rag_query: "RAG 检索问答",
    rag_graph: "RAG 知识图谱 / 制图",
  };
  const sourceUsageColumns: ColumnsType<UsageSummary["bySource"][number]> = [
    { title: "来源", dataIndex: "source", render: (value: keyof typeof sourceLabels) => sourceLabels[value] ?? value },
    { title: "模型请求", dataIndex: "requests" },
    { title: "输入 tokens", dataIndex: "inputTokens", render: (value: number) => value.toLocaleString() },
    { title: "输出 tokens", dataIndex: "outputTokens", render: (value: number) => value.toLocaleString() },
  ];

  return (
    <Flex vertical gap={12} style={{ flex: 1, minHeight: 0, padding: 16, overflowY: "auto" }}>
      <Flex align="flex-start" justify="space-between" gap={12} wrap>
        <Flex vertical gap={2}>
          <Typography.Text type="secondary" style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2 }}>
            RUNTIME CONFIGURATION
          </Typography.Text>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {sectionCopy[activeSection].title}
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ margin: "4px 0 0", fontSize: 12 }}>
            {sectionCopy[activeSection].subtitle}
          </Typography.Paragraph>
        </Flex>
        {activeSection === "providers" ? (
          <Flex gap={8}>
            <Button icon={<ReloadOutlined spin={loading} />} disabled={loading} onClick={() => void refresh()}>
              刷新
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setDraft(emptyDraft())}>
              新建 Provider
            </Button>
          </Flex>
        ) : null}
      </Flex>
      <Flex gap={12} align="flex-start" style={{ flex: 1, minHeight: 0 }}>
        <Card size="small" styles={{ body: { padding: 8 } }} style={{ width: 230, flex: "0 0 auto" }}>
          <Menu
            mode="vertical"
            selectedKeys={[activeSection]}
            items={sectionMenuItems}
            onSelect={(info) => selectSection(info.key as SettingsSection)}
            style={{ borderInlineEnd: "none" }}
          />
        </Card>
        <Flex vertical gap={12} style={{ flex: 1, minWidth: 0 }}>
          {activeSection === "providers" ? (
            <Flex vertical gap={12}>
              {error ? <Alert type="error" showIcon message={error} /> : null}
              <Card
                size="small"
                title="部署访问 Token"
                extra={<Tag>{studioToken ? "已配置" : "未配置"}</Tag>}
              >
                <Form layout="vertical">
                  <Form.Item label="主服务 Token" extra="与服务端 STUDIO_API_TOKEN 保持一致；本地未配置时留空">
                    <Input.Password
                      aria-label="主服务 Token"
                      value={studioToken}
                      onChange={(event) => {
                        setStudioToken(event.target.value);
                        setTokenSaved(false);
                      }}
                      autoComplete="new-password"
                      placeholder="部署环境配置后在此填写"
                    />
                  </Form.Item>
                  <Flex gap={8} align="center">
                    <Button
                      icon={<SaveOutlined />}
                      onClick={() => {
                        setStudioApiToken(studioToken);
                        setTokenSaved(true);
                        void refresh();
                      }}
                    >
                      保存并验证
                    </Button>
                    {tokenSaved ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>已保存，Provider 列表已刷新验证。</Typography.Text> : null}
                  </Flex>
                </Form>
              </Card>
              <Card
                size="small"
                title="工作空间归属"
                extra={<Tag>{workspaces.length}</Tag>}
              >
                {workspaceError ? <Alert type="error" showIcon message={workspaceError} style={{ marginBottom: 12 }} /> : null}
                <Form layout="vertical">
                  <Form.Item label="当前工作空间" extra="会话与用量按空间归集；切换后需刷新页面生效">
                    <Select
                      aria-label="当前工作空间"
                      value={activeWorkspace}
                      onChange={(value) => {
                        setActiveWorkspace(value);
                        setWorkspaceId(value);
                        void refreshUsage(usageAll);
                      }}
                      options={[
                        { value: "", label: "默认空间（未指定归属）" },
                        ...workspaces
                          .filter((workspace) => workspace.id !== "default")
                          .map((workspace) => ({ value: workspace.id, label: workspace.name })),
                      ]}
                    />
                  </Form.Item>
                  <Form.Item label="新建工作空间" extra="用于把会话与用量按部门/项目归集">
                    <Flex gap={8}>
                      <Input
                        aria-label="新建工作空间"
                        value={newWorkspaceName}
                        onChange={(event) => setNewWorkspaceName(event.target.value)}
                        placeholder="例如：交付部"
                      />
                      <Button
                        icon={<PlusOutlined />}
                        disabled={!newWorkspaceName.trim()}
                        onClick={() => {
                          void createWorkspace({ name: newWorkspaceName })
                            .then(() => {
                              setNewWorkspaceName("");
                              return refreshWorkspaces();
                            })
                            .catch((reason) =>
                              setWorkspaceError(
                                reason instanceof Error ? reason.message : "创建工作空间失败",
                              ),
                            );
                        }}
                      >
                        新建
                      </Button>
                    </Flex>
                  </Form.Item>
                </Form>
              </Card>
              <Card
                size="small"
                title="近 30 天用量"
                extra={
                  <Flex gap={8} wrap>
                    <Button
                      size="small"
                      onClick={() => {
                        const next = !usageAll;
                        setUsageAll(next);
                        void refreshUsage(next);
                      }}
                    >
                      {usageAll ? "只看当前空间" : "查看全局合计"}
                    </Button>
                    <Button
                      size="small"
                      icon={<DownloadOutlined />}
                      disabled={usageExporting !== null}
                      onClick={() => void exportUsage("csv")}
                    >
                      {usageExporting === "csv" ? "导出中..." : "导出 CSV"}
                    </Button>
                    <Button
                      size="small"
                      icon={<DownloadOutlined />}
                      disabled={usageExporting !== null}
                      onClick={() => void exportUsage("json")}
                    >
                      {usageExporting === "json" ? "导出中..." : "导出 JSON"}
                    </Button>
                  </Flex>
                }
              >
                {usageExportError ? (
                  <Alert type="error" showIcon message={`用量导出失败：${usageExportError}`} style={{ marginBottom: 12 }} />
                ) : null}
                {usage ? (
                  <Flex vertical gap={12}>
                    <Flex gap={16} wrap>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        模型请求 {usage.totals.requests} 次 · 工具 {usage.totals.toolCalls} 次 · 合计{" "}
                        {usage.totals.totalTokens.toLocaleString()} tokens
                      </Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        范围：{usage.workspaceId === "*" ? "全部工作空间" : usage.workspaceId}
                      </Typography.Text>
                    </Flex>
                    <Table
                      size="small"
                      rowKey="source"
                      columns={sourceUsageColumns}
                      dataSource={usage.bySource ?? []}
                      pagination={false}
                      scroll={{ x: "max-content" }}
                      locale={{ emptyText: <Empty description="该时间窗内还没有用量记录" /> }}
                    />
                    <Table
                      size="small"
                      rowKey="model"
                      columns={usageColumns}
                      dataSource={usage.byModel}
                      pagination={usage.byModel.length > 10 ? { pageSize: 10, showSizeChanger: false } : false}
                      scroll={{ x: "max-content" }}
                      locale={{ emptyText: <Empty description="该时间窗内还没有用量记录" /> }}
                    />
                  </Flex>
                ) : (
                  <Empty description="用量数据暂不可用（可能未配置部署 Token 或接口未就绪）。" />
                )}
              </Card>
              <Card
                size="small"
                title="服务商目录"
                extra={<Tag>{providers.length}</Tag>}
                styles={{ body: { padding: 0 } }}
              >
                <Table<ProviderMetadata>
                  size="small"
                  rowKey="id"
                  columns={providerColumns}
                  dataSource={providers}
                  loading={loading}
                  pagination={providers.length > 10 ? { pageSize: 10, showSizeChanger: false } : false}
                  scroll={{ x: "max-content" }}
                  locale={{ emptyText: <Empty description={loading ? "正在加载 Provider..." : "还没有 Provider"} /> }}
                />
              </Card>
            </Flex>
          ) : activeSection === "schema-sources" ? (
            <SchemaSourcesSection />
          ) : activeSection === "mcp-gateway" ? (
            <McpGatewaySection />
          ) : activeSection === "apps" ? (
            <PublishedAppsSection />
          ) : activeSection === "identity" ? (
            <IdentitySection
              status={identityStatus}
              loading={identityLoading}
              error={identityError}
              onRefresh={() => void refreshIdentity()}
            />
          ) : activeSection === "branding" ? (
            <BrandingSection />
          ) : (
            <ImChannelsSection />
          )}
        </Flex>
      </Flex>
      <ProviderModal
        draft={draft}
        setDraft={setDraft}
        saving={saving}
        onCancel={() => setDraft(null)}
        onSubmit={() => void submit()}
      />
    </Flex>
  );
}

function ProviderModal({
  draft,
  setDraft,
  saving,
  onCancel,
  onSubmit,
}: {
  draft: Draft | null;
  setDraft: (draft: Draft) => void;
  saving: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const { message } = App.useApp();
  const [fetching, setFetching] = useState(false);
  const [modelInput, setModelInput] = useState("");
  if (!draft) return null;
  const patch = (value: Partial<Draft>) => setDraft({ ...draft, ...value });
  const addModel = () => {
    const model = modelInput.trim();
    if (model && !draft.models.includes(model)) patch({ models: [...draft.models, model] });
    setModelInput("");
  };
  const autoFetch = async () => {
    setFetching(true);
    try {
      // 编辑已有 Provider 时走入库记录；新建时按当前表单参数探测，无需先保存。
      const models = draft.id
        ? await fetchProviderModels(draft.id)
        : await probeProviderModels({ baseUrl: draft.baseUrl, apiKey: draft.apiKey });
      patch({ models });
      void message.success(`已获取 ${models.length} 个模型`);
    } catch (reason) {
      void message.error(reason instanceof Error ? reason.message : "模型获取失败");
    } finally {
      setFetching(false);
    }
  };

  // 自动获取模型需要 Base URL；编辑态需已入库的 id，新建态只需 Base URL。
  const canAutoFetch = draft.id ? true : Boolean(draft.baseUrl.trim());
  return (
    <Modal
      centered
      open
      title={draft.id ? "编辑 Provider" : "新建 Provider"}
      onCancel={onCancel}
      footer={
        <Flex gap={8} justify="flex-end">
          <Button onClick={onCancel}>取消</Button>
          <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={onSubmit}>
            {saving ? "保存中" : "保存 Provider"}
          </Button>
        </Flex>
      }
    >
      <Form layout="vertical" preserve={false}>
        <Form.Item label="名称" required>
          <Input
            aria-label="Provider 名称"
            value={draft.name}
            onChange={(event) => patch({ name: event.target.value })}
            placeholder="例如 DeepSeek"
          />
        </Form.Item>
        <Form.Item label="Base URL" required>
          <Input
            aria-label="Base URL"
            value={draft.baseUrl}
            onChange={(event) => patch({ baseUrl: event.target.value })}
            placeholder="https://api.example.com/v1"
          />
        </Form.Item>
        <Form.Item label="接入格式" extra="决定请求协议与调用方式">
          <Select
            aria-label="接入格式"
            value={draft.format}
            onChange={(value) => patch({ format: value as ProviderFormat })}
            options={PROVIDER_FORMATS.map((format) => ({
              value: format,
              label: PROVIDER_FORMAT_LABELS[format],
            }))}
          />
        </Form.Item>
        <Form.Item label="API Key" extra={draft.id ? "留空保持不变" : "可选"}>
          <Input.Password
            aria-label="API Key"
            value={draft.apiKey}
            onChange={(event) => patch({ apiKey: event.target.value })}
            autoComplete="new-password"
          />
        </Form.Item>
        <Form.Item label="模型列表" extra="至少添加一个模型">
          <Flex vertical gap={8}>
            <Flex gap={4} wrap>
              {draft.models.map((model) => (
                <Tag key={model} closable onClose={() => patch({ models: draft.models.filter((item) => item !== model) })}>
                  {model}
                </Tag>
              ))}
              {draft.models.length === 0 ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>至少添加一个模型</Typography.Text>
              ) : null}
            </Flex>
            <Flex gap={8}>
              <Input
                aria-label="模型名"
                value={modelInput}
                onChange={(event) => setModelInput(event.target.value)}
                onPressEnter={addModel}
                placeholder="输入模型名后回车"
              />
              <Button icon={<PlusOutlined />} onClick={addModel} aria-label="添加模型">
                添加
              </Button>
              <Tooltip title={canAutoFetch ? "获取该 Provider 的模型列表" : "请先填写 Base URL"}>
                <Button
                  icon={<ReloadOutlined spin={fetching} />}
                  loading={fetching}
                  disabled={fetching || !canAutoFetch}
                  onClick={() => void autoFetch()}
                >
                  {fetching ? "获取中" : "自动获取"}
                </Button>
              </Tooltip>
            </Flex>
          </Flex>
        </Form.Item>
        <Form.Item label="启用 Provider" extra="禁用后不会出现在 Workflow 选择器">
          <Switch
            aria-label="启用 Provider"
            checked={draft.enabled}
            onChange={(checked) => patch({ enabled: checked })}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
