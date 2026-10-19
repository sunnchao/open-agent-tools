import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  CloseOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SaveOutlined,
  SettingOutlined,
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

function IdentitySection(props: {
  status: IdentityStatus | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  const { status, loading, error } = props;
  return (
    <main className="settings-content">
      {error ? <div className="settings-alert">{error}</div> : null}
      <div className="settings-intro">
        <div>
          <span className="settings-kicker">ENTERPRISE IDENTITY</span>
          <h2>
            <SafetyCertificateOutlined /> 企业身份接入
          </h2>
        </div>
        <button
          className="studio-button secondary"
          type="button"
          onClick={props.onRefresh}
          disabled={loading}
        >
          <ReloadOutlined spin={loading} /> <span>刷新状态</span>
        </button>
      </div>

      {status ? (
        <>
          {status.configError ? (
            <div className="settings-alert">
              身份配置未生效:{status.configError}
              。受保护接口当前拒绝访问,请修正环境变量后重启服务。
            </div>
          ) : null}
          <div className="provider-table-wrap">
            <table className="provider-table">
              <thead>
                <tr>
                  <th>项目</th>
                  <th>当前值</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td data-label="项目">
                    <b>Studio 身份提供商</b>
                  </td>
                  <td data-label="当前值">
                    <span className={`status-pill${status.enabled ? " is-enabled" : ""}`}>
                      {identityProviderLabel[status.provider]}
                    </span>
                  </td>
                  <td data-label="说明">OIDC 优先;部署 Token 仅作显式兼容回退。</td>
                </tr>
                <tr>
                  <td data-label="项目">
                    <b>Issuer / Audience</b>
                  </td>
                  <td data-label="当前值">
                    <code>{status.issuer ?? "未配置"}</code>
                    <code>{status.audience ?? "未配置"}</code>
                  </td>
                  <td data-label="说明">服务端校验 JWT 的签发方与受众,不接受前端传入。</td>
                </tr>
                <tr>
                  <td data-label="项目">
                    <b>组 / 角色 Claim</b>
                  </td>
                  <td data-label="当前值">
                    <code>{status.groupsClaim}</code>
                    <code>{status.rolesClaim}</code>
                  </td>
                  <td data-label="说明">管理员角色:{status.adminRoles.join(", ") || "未配置"}</td>
                </tr>
                <tr>
                  <td data-label="项目">
                    <b>LDAP 网关</b>
                  </td>
                  <td data-label="当前值">
                    <span
                      className={`status-pill${status.ldap.readiness === "ready" ? " is-enabled" : ""}`}
                    >
                      {ldapReadinessLabel[status.ldap.readiness]}
                    </span>
                  </td>
                  <td data-label="说明">{status.ldap.summary}</td>
                </tr>
                {status.ldap.configError ? (
                  <tr>
                    <td data-label="项目">
                      <b>LDAP 配置错误</b>
                    </td>
                    <td data-label="当前值" colSpan={2}>
                      {status.ldap.configError}
                    </td>
                  </tr>
                ) : null}
                <tr>
                  <td data-label="项目">
                    <b>LDAP → HMAC 断言</b>
                  </td>
                  <td data-label="当前值">
                    <code>{status.ldap.assertionKeyId ?? "未配置 Key ID"}</code>
                    <code>{status.ldap.identityMode}</code>
                  </td>
                  <td data-label="说明">
                    {status.ldap.assertionIssuer ?? "未配置 Issuer"} /{" "}
                    {status.ldap.assertionAudience ?? "未配置 Audience"}。HMAC secret
                    仅保留在服务端与网关。
                  </td>
                </tr>
                <tr>
                  <td data-label="项目">
                    <b>密码处理</b>
                  </td>
                  <td data-label="当前值">
                    <span className="status-pill">不接收</span>
                  </td>
                  <td data-label="说明">
                    Agent Server 不在请求中 bind LDAP,不保存 LDAP 密码或 OIDC client secret。
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mcp-gateway-note">
            当前配置:
            {status.ldap.gatewayConfigured ? " 已配置可信网关入口;" : " 未配置可信网关入口;"}
            {status.deploymentTokenFallback
              ? " 部署 Token 回退已启用。"
              : " 未启用部署 Token 回退。"}
          </p>
        </>
      ) : (
        <div className="settings-intro">
          <span>{loading ? "正在读取身份接入状态..." : "暂无身份接入状态。"}</span>
        </div>
      )}
    </main>
  );
}

export function SettingsWorkspace() {
  const sectionNavRef = useRef<HTMLElement>(null);
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

  useEffect(() => {
    if (!window.matchMedia("(max-width: 760px)").matches) return;
    sectionNavRef.current
      ?.querySelector<HTMLElement>(".settings-section.is-active")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeSection]);

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

  // 用量明细导出:带当前空间范围,通过 studioFetch 携带鉴权头后保存为文件。
  const exportUsage = async (format: ExportFormat) => {
    if (usageExporting) return;
    setUsageExporting(format);
    setUsageExportError(null);
    try {
      await downloadExport(
        usageExportPath({ days: 30, all: usageAll }, format),
        `usage-events.${format}`,
      );
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
      await saveProvider(draft);
      setDraft(null);
      await refresh();
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
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "设置默认 Provider 失败");
    } finally {
      setDefaultingId(null);
    }
  };

  return (
    <section className="settings-workspace">
      <header className="domain-header settings-header">
        <div>
          <p className="domain-eyebrow">RUNTIME CONFIGURATION</p>
          <h1>
            <SettingOutlined /> {sectionCopy[activeSection].title}
          </h1>
          <p className="domain-subtitle">{sectionCopy[activeSection].subtitle}</p>
        </div>
        {activeSection === "providers" ? (
          <div className="domain-header-actions">
            <button
              className="studio-button secondary"
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
            >
              <ReloadOutlined spin={loading} /> <span>刷新</span>
            </button>
            <button
              className="studio-button primary"
              type="button"
              onClick={() => setDraft(emptyDraft())}
            >
              <PlusOutlined /> <span>新建 Provider</span>
            </button>
          </div>
        ) : null}
      </header>
      <div className="settings-body">
        <aside className="settings-sections" ref={sectionNavRef}>
          <button
            type="button"
            className={`settings-section${activeSection === "providers" ? " is-active" : ""}`}
            aria-current={activeSection === "providers" ? "page" : undefined}
            onClick={() => selectSection("providers")}
          >
            <span>01</span>
            <b>模型 Provider</b>
            <small>路由与模型目录</small>
          </button>
          <button
            type="button"
            className={`settings-section${activeSection === "schema-sources" ? " is-active" : ""}`}
            aria-current={activeSection === "schema-sources" ? "page" : undefined}
            onClick={() => selectSection("schema-sources")}
          >
            <span>02</span>
            <b>Schema 数据源</b>
            <small>问数连接与目录</small>
          </button>
          <button
            type="button"
            className={`settings-section${activeSection === "mcp-gateway" ? " is-active" : ""}`}
            aria-current={activeSection === "mcp-gateway" ? "page" : undefined}
            onClick={() => selectSection("mcp-gateway")}
          >
            <span>03</span>
            <b>MCP Gateway</b>
            <small>地址与 API Key</small>
          </button>
          <button
            type="button"
            className={`settings-section${activeSection === "im" ? " is-active" : ""}`}
            aria-current={activeSection === "im" ? "page" : undefined}
            onClick={() => selectSection("im")}
          >
            <span>04</span>
            <b>IM 渠道</b>
            <small>飞书 / 钉钉机器人</small>
          </button>
          <button
            type="button"
            className={`settings-section${activeSection === "apps" ? " is-active" : ""}`}
            aria-current={activeSection === "apps" ? "page" : undefined}
            onClick={() => selectSection("apps")}
          >
            <span>05</span>
            <b>员工入口</b>
            <small>发布问答应用</small>
          </button>
          <button
            type="button"
            className={`settings-section${activeSection === "identity" ? " is-active" : ""}`}
            aria-current={activeSection === "identity" ? "page" : undefined}
            onClick={() => selectSection("identity")}
          >
            <span>06</span>
            <b>企业身份</b>
            <small>OIDC / LDAP 接入</small>
          </button>
          <button
            type="button"
            className={`settings-section${activeSection === "branding" ? " is-active" : ""}`}
            aria-current={activeSection === "branding" ? "page" : undefined}
            onClick={() => selectSection("branding")}
          >
            <span>07</span>
            <b>品牌与渠道</b>
            <small>白标 / 分销码</small>
          </button>
        </aside>
        {activeSection === "providers" ? (
          <main className="settings-content">
            {error ? <div className="settings-alert">{error}</div> : null}
            <div className="settings-intro">
              <div>
                <span className="settings-kicker">STUDIO ACCESS</span>
                <h2>部署访问 Token</h2>
              </div>
              <span>{studioToken ? "已配置" : "未配置"}</span>
            </div>
            <div className="settings-modal-fields">
              <label className="studio-field">
                <span>
                  主服务 Token <small>与服务端 STUDIO_API_TOKEN 保持一致；本地未配置时留空</small>
                </span>
                <input
                  type="password"
                  value={studioToken}
                  onChange={(event) => {
                    setStudioToken(event.target.value);
                    setTokenSaved(false);
                  }}
                  autoComplete="new-password"
                  placeholder="部署环境配置后在此填写"
                />
              </label>
              <div className="domain-header-actions">
                <button
                  className="studio-button secondary"
                  type="button"
                  onClick={() => {
                    setStudioApiToken(studioToken);
                    setTokenSaved(true);
                    void refresh();
                  }}
                >
                  <SaveOutlined /> <span>保存并验证</span>
                </button>
                {tokenSaved ? <span>已保存，Provider 列表已刷新验证。</span> : null}
              </div>
            </div>

            <div className="settings-intro">
              <div>
                <span className="settings-kicker">WORKSPACE</span>
                <h2>工作空间归属</h2>
              </div>
              <span>{workspaces.length} 个工作空间</span>
            </div>
            {workspaceError ? <div className="settings-alert">{workspaceError}</div> : null}
            <div className="settings-modal-fields">
              <label className="studio-field">
                <span>
                  当前工作空间 <small>会话与用量按空间归集；切换后需刷新页面生效</small>
                </span>
                <select
                  value={activeWorkspace}
                  onChange={(event) => {
                    const next = event.target.value;
                    setActiveWorkspace(next);
                    setWorkspaceId(next);
                    void refreshUsage(usageAll);
                  }}
                >
                  <option value="">默认空间（未指定归属）</option>
                  {workspaces
                    .filter((workspace) => workspace.id !== "default")
                    .map((workspace) => (
                      <option key={workspace.id} value={workspace.id}>
                        {workspace.name}
                      </option>
                    ))}
                </select>
              </label>
              <label className="studio-field">
                <span>
                  新建工作空间 <small>用于把会话与用量按部门/项目归集</small>
                </span>
                <input
                  value={newWorkspaceName}
                  onChange={(event) => setNewWorkspaceName(event.target.value)}
                  placeholder="例如：交付部"
                />
              </label>
              <div className="domain-header-actions">
                <button
                  className="studio-button secondary"
                  type="button"
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
                  <PlusOutlined /> <span>新建工作空间</span>
                </button>
              </div>
            </div>

            <div className="settings-intro">
              <div>
                <span className="settings-kicker">USAGE</span>
                <h2>近 30 天用量</h2>
              </div>
              <div className="domain-header-actions">
                <button
                  className="studio-button secondary"
                  type="button"
                  onClick={() => {
                    const next = !usageAll;
                    setUsageAll(next);
                    void refreshUsage(next);
                  }}
                >
                  {usageAll ? "只看当前空间" : "查看全局合计"}
                </button>
                <button
                  className="studio-button secondary"
                  type="button"
                  disabled={usageExporting !== null}
                  onClick={() => void exportUsage("csv")}
                >
                  <DownloadOutlined /> {usageExporting === "csv" ? "导出中..." : "导出 CSV"}
                </button>
                <button
                  className="studio-button secondary"
                  type="button"
                  disabled={usageExporting !== null}
                  onClick={() => void exportUsage("json")}
                >
                  <DownloadOutlined /> {usageExporting === "json" ? "导出中..." : "导出 JSON"}
                </button>
              </div>
            </div>
            {usageExportError ? (
              <div className="settings-alert">用量导出失败:{usageExportError}</div>
            ) : null}
            {usage ? (
              <>
                <div className="settings-intro">
                  <span>
                    对话 {usage.totals.chatTurns} 轮 · 工具 {usage.totals.toolCalls} 次 · 合计{" "}
                    {usage.totals.totalTokens.toLocaleString()} tokens
                  </span>
                  <span>
                    范围：{usage.workspaceId === "*" ? "全部工作空间" : usage.workspaceId}
                  </span>
                </div>
                <div className="provider-table-wrap">
                  <table className="provider-table">
                    <thead>
                      <tr>
                        <th>模型</th>
                        <th>对话轮数</th>
                        <th>输入 tokens</th>
                        <th>输出 tokens</th>
                      </tr>
                    </thead>
                    <tbody>
                      {usage.byModel.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="table-empty">
                            该时间窗内还没有用量记录
                          </td>
                        </tr>
                      ) : (
                        usage.byModel.map((entry) => (
                          <tr key={entry.model}>
                            <td data-label="模型">
                              <code>{entry.model}</code>
                            </td>
                            <td data-label="对话轮数">{entry.chatTurns}</td>
                            <td data-label="输入">{entry.inputTokens.toLocaleString()}</td>
                            <td data-label="输出">{entry.outputTokens.toLocaleString()}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <div className="settings-intro">
                <span>用量数据暂不可用（可能未配置部署 Token 或接口未就绪）。</span>
              </div>
            )}
            <div className="settings-intro">
              <div>
                <span className="settings-kicker">MODEL ROUTING</span>
                <h2>服务商目录</h2>
              </div>
              <span>{providers.length} 个 Provider</span>
            </div>
            <div className="provider-table-wrap">
              <table className="provider-table">
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>Base URL</th>
                    <th>API Key</th>
                    <th>格式</th>
                    <th>模型</th>
                    <th>状态</th>
                    <th>默认</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {loading && providers.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="table-empty">
                        正在加载 Provider...
                      </td>
                    </tr>
                  ) : null}
                  {!loading && providers.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="table-empty">
                        还没有 Provider
                      </td>
                    </tr>
                  ) : null}
                  {providers.map((provider) => (
                    <tr key={provider.id}>
                      <td data-label="Provider">
                        <div className="provider-name">
                          <span
                            className={`provider-dot${provider.enabled ? "" : " is-disabled"}`}
                          />
                          <b>{provider.name}</b>
                          <small>{provider.id}</small>
                        </div>
                      </td>
                      <td data-label="Base URL">
                        <code title={provider.baseUrl}>{provider.baseUrl}</code>
                      </td>
                      <td data-label="API Key">
                        <span className="masked-key">{provider.apiKeyMasked ?? "未配置"}</span>
                      </td>
                      <td data-label="格式">
                        <span className="format-pill">
                          {PROVIDER_FORMAT_LABELS[provider.format]}
                        </span>
                      </td>
                      <td data-label="模型">
                        <span className="model-count">{provider.models.length}</span>
                      </td>
                      <td data-label="状态">
                        <span className={`status-pill${provider.enabled ? " is-enabled" : ""}`}>
                          {provider.enabled ? "启用" : "停用"}
                        </span>
                      </td>
                      <td data-label="默认路由">
                        {provider.isDefault ? (
                          <span className="default-mark">DEFAULT</span>
                        ) : (
                          <button
                            className="set-default-button"
                            type="button"
                            title={provider.enabled ? "设为默认" : "请先启用 Provider"}
                            disabled={!provider.enabled || defaultingId !== null}
                            onClick={() => void makeDefault(provider)}
                          >
                            <StarOutlined />
                            <span>{defaultingId === provider.id ? "设置中" : "设为默认"}</span>
                          </button>
                        )}
                      </td>
                      <td data-label="操作">
                        <div className="table-actions">
                          <button
                            type="button"
                            title="编辑"
                            aria-label={`编辑 ${provider.name}`}
                            onClick={() => edit(provider)}
                          >
                            <EditOutlined />
                          </button>
                          {provider.isDefault ? null : (
                            <button
                              type="button"
                              title="删除"
                              aria-label={`删除 ${provider.name}`}
                              onClick={() => {
                                if (window.confirm(`删除 ${provider.name}？`))
                                  void removeProvider(provider.id)
                                    .then(refresh)
                                    .catch((reason) =>
                                      setError(
                                        reason instanceof Error ? reason.message : "删除失败",
                                      ),
                                    );
                              }}
                            >
                              <DeleteOutlined />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </main>
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
      </div>
      {draft
        ? createPortal(
            <ProviderModal
              draft={draft}
              setDraft={setDraft}
              saving={saving}
              onCancel={() => setDraft(null)}
              onSubmit={() => void submit()}
            />,
            document.body,
          )
        : null}
    </section>
  );
}

function ProviderModal({
  draft,
  setDraft,
  saving,
  onCancel,
  onSubmit,
}: {
  draft: Draft;
  setDraft: (draft: Draft) => void;
  saving: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const [fetching, setFetching] = useState(false);
  const [modelInput, setModelInput] = useState("");
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
    } catch (reason) {
      window.alert(reason instanceof Error ? reason.message : "模型获取失败");
    } finally {
      setFetching(false);
    }
  };

  // 自动获取模型需要 Base URL；编辑态需已入库的 id，新建态只需 Base URL。
  const canAutoFetch = draft.id ? true : Boolean(draft.baseUrl.trim());
  return (
    <div
      className="settings-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-modal-title"
      >
        <div className="settings-modal-head">
          <div>
            <span className="settings-kicker">PROVIDER EDITOR</span>
            <h2 id="provider-modal-title">{draft.id ? "编辑 Provider" : "新建 Provider"}</h2>
          </div>
          <button type="button" aria-label="关闭" onClick={onCancel}>
            <CloseOutlined />
          </button>
        </div>
        <div className="settings-modal-fields">
          <label className="studio-field">
            <span>名称</span>
            <input
              value={draft.name}
              onChange={(event) => patch({ name: event.target.value })}
              placeholder="例如 DeepSeek"
            />
          </label>
          <label className="studio-field">
            <span>Base URL</span>
            <input
              value={draft.baseUrl}
              onChange={(event) => patch({ baseUrl: event.target.value })}
              placeholder="https://api.example.com/v1"
            />
          </label>
          <label className="studio-field">
            <span>
              接入格式 <small>决定请求协议与调用方式</small>
            </span>
            <select
              value={draft.format}
              onChange={(event) => patch({ format: event.target.value as ProviderFormat })}
            >
              {PROVIDER_FORMATS.map((format) => (
                <option key={format} value={format}>
                  {PROVIDER_FORMAT_LABELS[format]}
                </option>
              ))}
            </select>
          </label>
          <label className="studio-field">
            <span>
              API Key <small>{draft.id ? "留空保持不变" : "可选"}</small>
            </span>
            <input
              type="password"
              value={draft.apiKey}
              onChange={(event) => patch({ apiKey: event.target.value })}
              autoComplete="new-password"
            />
          </label>
          <div className="studio-field">
            <span>模型列表</span>
            <div className="model-editor">
              <div className="model-tags">
                {draft.models.map((model) => (
                  <span className="model-tag" key={model}>
                    {model}
                    <button
                      type="button"
                      aria-label={`移除 ${model}`}
                      onClick={() =>
                        patch({ models: draft.models.filter((item) => item !== model) })
                      }
                    >
                      <CloseOutlined />
                    </button>
                  </span>
                ))}
                {draft.models.length === 0 ? <small>至少添加一个模型</small> : null}
              </div>
              <div className="model-editor-input">
                <input
                  value={modelInput}
                  onChange={(event) => setModelInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addModel();
                    }
                  }}
                  placeholder="输入模型名后回车"
                />
                <button type="button" onClick={addModel}>
                  <PlusOutlined />
                </button>
                <button
                  type="button"
                  onClick={() => void autoFetch()}
                  disabled={fetching || !canAutoFetch}
                  title={canAutoFetch ? "获取该 Provider 的模型列表" : "请先填写 Base URL"}
                >
                  <ReloadOutlined spin={fetching} /> {fetching ? "获取中" : "自动获取"}
                </button>
              </div>
            </div>
          </div>
          <label className="toggle-field">
            <span className="toggle-field__copy">
              <b>启用 Provider</b>
              <small>禁用后不会出现在 Workflow 选择器</small>
            </span>
            <span className="settings-switch">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => patch({ enabled: event.target.checked })}
              />
              <span aria-hidden="true" />
            </span>
          </label>
        </div>
        <div className="settings-modal-actions">
          <button className="studio-button secondary" type="button" onClick={onCancel}>
            取消
          </button>
          <button
            className="studio-button primary"
            type="button"
            disabled={saving}
            onClick={onSubmit}
          >
            <SaveOutlined /> {saving ? "保存中" : "保存 Provider"}
          </button>
        </div>
      </div>
    </div>
  );
}
