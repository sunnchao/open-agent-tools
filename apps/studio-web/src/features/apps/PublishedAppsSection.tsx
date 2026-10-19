import { useEffect, useState } from "react";
import { Button, Select, Spin, Tag } from "antd";
import { CopyOutlined, DeleteOutlined, PlusOutlined, ReloadOutlined } from "../../lib/icons.js";
import { useResourceCatalog } from "../resources/useResourceCatalog.js";
import {
  createPublishedApp,
  deletePublishedApp,
  employeeEntryPath,
  fetchPublishedAppIdentity,
  fetchPublishedApps,
  rotateAccessToken,
  updatePublishedApp,
  type PublishedAppRecord,
  type PublishedAppResources,
  type PublishedAppIdentity,
} from "./adminApi.js";

/**
 * 发布态管理：把「知识库 + 工具 + 提示词」打包成员工可用入口。
 *
 * 只暴露发布所需的最少配置（名称、欢迎语、示例问题、资源绑定），
 * 让管理员能在 3 步内交付一个可用的员工入口，而不是去配 Provider 与协议。
 */
export function PublishedAppsSection() {
  const [apps, setApps] = useState<PublishedAppRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [welcome, setWelcome] = useState("");
  const [ragSources, setRagSources] = useState<string[]>([]);
  const [sqlSources, setSqlSources] = useState<string[]>([]);
  const [allowedGroupsText, setAllowedGroupsText] = useState("");
  const [busy, setBusy] = useState(false);
  const [identity, setIdentity] = useState<PublishedAppIdentity | null>(null);
  // 刚生成的口令：只在内存里保留到刷新，用于展示与复制。
  const [freshTokens, setFreshTokens] = useState<Record<string, string>>({});
  const catalog = useResourceCatalog();

  const parseGroups = (value: string): string[] =>
    value
      .split(/[,，\n]/)
      .map((group) => group.trim())
      .filter((group, index, all) => Boolean(group) && all.indexOf(group) === index)
      .slice(0, 50);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextApps, nextIdentity] = await Promise.all([
        fetchPublishedApps(),
        fetchPublishedAppIdentity(),
      ]);
      setApps(nextApps);
      setIdentity(nextIdentity);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "发布应用加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const resources: PublishedAppResources = {};
      if (ragSources.length > 0) resources.rag = { sources: ragSources, topK: 5 };
      if (sqlSources.length > 0) resources.sqlSources = sqlSources;
      await createPublishedApp({
        name: name.trim(),
        welcome: welcome.trim(),
        resources,
        allowedGroups: parseGroups(allowedGroupsText),
        suggestions: [],
      });
      setName("");
      setWelcome("");
      setRagSources([]);
      setSqlSources([]);
      setAllowedGroupsText("");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "创建失败");
    } finally {
      setBusy(false);
    }
  };

  const toggleStatus = async (app: PublishedAppRecord) => {
    try {
      await updatePublishedApp(app.id, {
        status: app.status === "ACTIVE" ? "ARCHIVED" : "ACTIVE",
      });
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "状态更新失败");
    }
  };

  const remove = async (app: PublishedAppRecord) => {
    if (!window.confirm(`删除发布应用「${app.name}」？员工入口将立即失效。`)) return;
    try {
      await deletePublishedApp(app.id);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除失败");
    }
  };

  const entryUrl = (app: PublishedAppRecord) =>
    `${window.location.origin}${window.location.pathname}${employeeEntryPath(
      app.slug,
      freshTokens[app.id] ?? null,
    )}`;

  const toggleAccess = async (app: PublishedAppRecord) => {
    const enable = app.accessMode !== "token";
    try {
      const result = await rotateAccessToken(app.id, enable);
      if (result.token) {
        setFreshTokens((prev) => ({ ...prev, [app.id]: result.token as string }));
      } else {
        setFreshTokens((prev) => {
          const next = { ...prev };
          delete next[app.id];
          return next;
        });
      }
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "口令操作失败");
    }
  };

  const saveQuota = async (
    app: PublishedAppRecord,
    patch: { rateLimitPerMinute?: number; dailyTokenBudget?: number },
  ) => {
    try {
      await updatePublishedApp(app.id, patch);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "配额保存失败");
    }
  };

  return (
    <main className="settings-content">
      {error ? <div className="settings-alert">{error}</div> : null}

      <div className="settings-intro">
        <div>
          <span className="settings-kicker">PUBLISHED APPS</span>
          <h2>员工入口</h2>
        </div>
        <span>{apps.length} 个已发布应用</span>
      </div>
      <p style={{ marginTop: -6, marginBottom: 14, fontSize: 13, color: "#6b7077" }}>
        把知识库与工具打包成一个独立入口。员工打开链接即可问答，看不到
        Provider、资源抽屉与会话管理。
      </p>

      <div className="settings-modal-fields">
        <label className="studio-field">
          <span>应用名称</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：制度问答助手"
          />
        </label>
        <label className="studio-field">
          <span>
            欢迎语 <small>显示在员工首次进入时</small>
          </span>
          <input
            value={welcome}
            onChange={(event) => setWelcome(event.target.value)}
            placeholder="你好，我可以回答公司制度相关问题。"
          />
        </label>
        <label className="studio-field">
          <span>
            知识库来源 <small>员工提问只在这些文档中检索</small>
          </span>
          <Select
            mode="multiple"
            allowClear
            placeholder={catalog.loading ? "加载中…" : "选择知识库文档"}
            value={ragSources}
            onChange={setRagSources}
            options={(catalog.catalog?.rag.sources ?? []).map((source) => ({
              value: source.source,
              label: `${source.source}（${source.chunks} 段）`,
            }))}
          />
        </label>
        <label className="studio-field">
          <span>
            问数数据源 <small>可选，勾选后员工可直接问数</small>
          </span>
          <Select
            mode="multiple"
            allowClear
            placeholder={catalog.loading ? "加载中…" : "选择数据源"}
            value={sqlSources}
            onChange={setSqlSources}
            options={(catalog.catalog?.sql?.sources ?? []).map((source) => ({
              value: source.id,
              label: source.name,
            }))}
          />
        </label>
        <label className="studio-field">
          <span>
            文档可见分组（最大范围） <small>可选；只接受网关签名断言与这里声明分组的交集</small>
          </span>
          <input
            value={allowedGroupsText}
            onChange={(event) => setAllowedGroupsText(event.target.value)}
            placeholder="hr, finance, leadership"
          />
        </label>
        <div className="domain-header-actions">
          <Button
            type="primary"
            icon={<PlusOutlined />}
            loading={busy}
            disabled={!name.trim()}
            onClick={() => void create()}
          >
            发布应用
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => void refresh()} loading={loading}>
            刷新
          </Button>
        </div>
      </div>

      <div className="settings-modal-fields" style={{ marginTop: 0 }}>
        <div className="settings-intro" style={{ padding: 0 }}>
          <div>
            <span className="settings-kicker">TRUSTED GATEWAY</span>
            <h3 style={{ margin: "4px 0" }}>可信身份接入</h3>
          </div>
          <Tag color={identity?.enabled ? "green" : "orange"}>
            {identity?.enabled ? "已启用验证" : "未配置断言密钥"}
          </Tag>
        </div>
        <div className="gateway-endpoint" style={{ fontSize: 12 }}>
          <div>请求头：{identity?.assertionHeader ?? "X-Viewer-Assertion"}</div>
          <div>Key ID：{identity?.keyId ?? "—"}</div>
          <div>Issuer：{identity?.issuer ?? "—"}</div>
          <div>Audience：{identity?.audience ?? "—"}</div>
          <div>
            身份模式：
            {identity?.identityMode === "required"
              ? "所有应用强制"
              : identity?.identityMode === "required_for_groups"
                ? "声明分组时强制"
                : "可选（无断言仅公开文档）"}
          </div>
        </div>
        <small style={{ color: "#6b7077" }}>
          HMAC 密钥只配置在网关与 Agent Server 的 Secret 中，不会下发到浏览器。员工请求体不接受
          viewerGroups。
        </small>
      </div>

      <div className="provider-table-wrap">
        <table className="provider-table">
          <thead>
            <tr>
              <th>应用</th>
              <th>入口</th>
              <th>访问</th>
              <th>配额</th>
              <th>能力</th>
              <th>状态</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {loading && apps.length === 0 ? (
              <tr>
                <td colSpan={7} className="table-empty">
                  <Spin size="small" /> 正在加载…
                </td>
              </tr>
            ) : null}
            {!loading && apps.length === 0 ? (
              <tr>
                <td colSpan={7} className="table-empty">
                  还没有发布应用
                </td>
              </tr>
            ) : null}
            {apps.map((app) => (
              <tr key={app.id}>
                <td data-label="应用">
                  <div className="provider-name">
                    <b>{app.name}</b>
                    <small>{app.slug}</small>
                  </div>
                </td>
                <td data-label="入口">
                  <code title={entryUrl(app)}>
                    {employeeEntryPath(app.slug, freshTokens[app.id] ?? null)}
                  </code>
                  <Button
                    type="text"
                    size="small"
                    icon={<CopyOutlined />}
                    title="复制员工入口链接"
                    onClick={() => {
                      void navigator.clipboard?.writeText(entryUrl(app));
                    }}
                  />
                </td>
                <td data-label="访问">
                  <Tag color={app.accessMode === "token" ? "red" : "default"}>
                    {app.accessMode === "token" ? "口令" : "公开"}
                  </Tag>
                  {app.accessMode === "token" ? (
                    <small style={{ display: "block", color: "#9a9ea5" }}>
                      {freshTokens[app.id] ?? app.accessTokenHint ?? "已设置"}
                    </small>
                  ) : null}
                  <Button type="link" size="small" onClick={() => void toggleAccess(app)}>
                    {app.accessMode === "token" ? "撤销口令" : "加口令"}
                  </Button>
                </td>
                <td data-label="配额">
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <small>每分钟 {app.rateLimitPerMinute || "不限"} 次</small>
                    <small>
                      每日 {app.dailyTokenBudget ? `${app.dailyTokenBudget} tokens` : "不限"}
                    </small>
                    <Button
                      type="link"
                      size="small"
                      style={{ padding: 0, height: 18 }}
                      onClick={() => {
                        const rate = window.prompt(
                          "每分钟请求上限（0 = 不限）",
                          String(app.rateLimitPerMinute),
                        );
                        if (rate === null) return;
                        const budget = window.prompt(
                          "每日 token 预算（0 = 不限）",
                          String(app.dailyTokenBudget),
                        );
                        if (budget === null) return;
                        void saveQuota(app, {
                          rateLimitPerMinute: Number(rate),
                          dailyTokenBudget: Number(budget),
                        });
                      }}
                    >
                      调整配额
                    </Button>
                  </div>
                </td>
                <td data-label="能力">
                  <Tag color="orange">知识库 {app.resources.rag?.sources?.length ?? 0}</Tag>
                  <Tag color="blue">问数 {app.resources.sqlSources?.length ?? 0}</Tag>
                  <Tag color={app.allowedGroups.length > 0 ? "green" : "default"}>
                    分组 {app.allowedGroups.length > 0 ? app.allowedGroups.join(", ") : "仅公开"}
                  </Tag>
                </td>
                <td data-label="状态">
                  <span className={`status-pill${app.status === "ACTIVE" ? " is-enabled" : ""}`}>
                    {app.status === "ACTIVE" ? "已上线" : "已下线"}
                  </span>
                </td>
                <td data-label="操作">
                  <div className="table-actions">
                    <Button type="link" size="small" onClick={() => void toggleStatus(app)}>
                      {app.status === "ACTIVE" ? "下线" : "上线"}
                    </Button>
                    <Button
                      type="text"
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      title="删除"
                      onClick={() => void remove(app)}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
