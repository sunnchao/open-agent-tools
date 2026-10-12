import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  CloseOutlined,
  CopyOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
  StarOutlined,
  SyncOutlined,
} from "../../lib/icons.js";
import {
  duplicateSchemaSource,
  fetchAdminSchemaSources,
  fetchSchemaCatalog,
  removeSchemaSource,
  saveSchemaSource,
  setDefaultSchemaSource,
  syncSchemaSource,
  testSchemaSource,
  type SchemaCatalogPreview,
  type SchemaSourceConnector,
  type SchemaSourceDraft,
  type SchemaSourceMetadata,
} from "../observatory/api.js";

const emptyDraft = (): SchemaSourceDraft => ({
  name: "",
  connector: "mysql",
  connectionString: "",
  host: "",
  port: 3306,
  username: "",
  password: "",
  databaseName: "",
  schemaName: "",
  tableFilter: [],
  semanticProfile: "generic",
  enabled: true,
});

function formatSyncTime(value: string | null): string {
  if (!value) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function connectorLabel(connector: SchemaSourceConnector): string {
  return connector === "postgresql" ? "PostgreSQL" : "MySQL";
}

function connectionPlaceholder(connector: SchemaSourceConnector): string {
  return connector === "postgresql"
    ? "postgresql://readonly:password@host:5432/database"
    : "mysql://readonly:password@host:3306/database";
}

export function SchemaSourcesSection() {
  const [sources, setSources] = useState<SchemaSourceMetadata[]>([]);
  const [draft, setDraft] = useState<SchemaSourceDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [defaultingId, setDefaultingId] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [preview, setPreview] = useState<SchemaCatalogPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      setSources(await fetchAdminSchemaSources());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Schema 源加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const edit = (source: SchemaSourceMetadata) => {
    if (source.managedByEnv) return;
    setError(null);
    setDraft({
      id: source.id,
      name: source.name,
      connector: source.connector,
      connectionString: "",
      host: source.host,
      port: source.port,
      username: source.username,
      password: "",
      databaseName: source.databaseName ?? "",
      schemaName: source.schemaName ?? "",
      tableFilter: source.tableFilter,
      semanticProfile: source.semanticProfile,
      enabled: source.enabled,
    });
  };

  const submit = async (input: SchemaSourceDraft) => {
    setSaving(true);
    setError(null);
    try {
      await saveSchemaSource(input);
      setDraft(null);
      setNotice("Schema 源已保存；首次打开时会采集目录并构建关系图。");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Schema 源保存失败");
    } finally {
      setSaving(false);
    }
  };

  const makeDefault = async (source: SchemaSourceMetadata) => {
    setDefaultingId(source.id);
    setError(null);
    try {
      await setDefaultSchemaSource(source.id);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "设置默认 Schema 源失败");
    } finally {
      setDefaultingId(null);
    }
  };

  const probeExisting = async (source: SchemaSourceMetadata) => {
    setTestingId(source.id);
    setError(null);
    setNotice(null);
    try {
      const result = await testSchemaSource({ id: source.id });
      setNotice(
        `连接成功：${result.database} · ${connectorLabel(source.connector)} ${result.version}`,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "连接测试失败");
    } finally {
      setTestingId(null);
    }
  };

  const synchronize = async (source: SchemaSourceMetadata) => {
    setSyncingId(source.id);
    setError(null);
    setNotice(null);
    try {
      const synced = await syncSchemaSource(source.id);
      setNotice(
        `${source.name} 已同步：${synced.tableCount} 张表 · ${synced.relationCount} 条关系`,
      );
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Schema 同步失败");
      await refresh();
    } finally {
      setSyncingId(null);
    }
  };

  const duplicate = async (source: SchemaSourceMetadata) => {
    setDuplicatingId(source.id);
    setError(null);
    try {
      await duplicateSchemaSource(source.id);
      setNotice(`已创建“${source.name}”副本；副本默认停用，请编辑确认后再启用。`);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "复制数据源失败");
    } finally {
      setDuplicatingId(null);
    }
  };

  const openPreview = async (source: SchemaSourceMetadata) => {
    setPreviewingId(source.id);
    setError(null);
    try {
      setPreview(await fetchSchemaCatalog(source.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Schema 预览加载失败");
    } finally {
      setPreviewingId(null);
    }
  };

  return (
    <main className="settings-content schema-source-settings">
      {error ? <div className="settings-alert">{error}</div> : null}
      {notice ? <div className="settings-notice">{notice}</div> : null}
      <div className="settings-intro">
        <div>
          <span className="settings-kicker">SCHEMA ROUTING</span>
          <h2>数据源目录</h2>
        </div>
        <div className="settings-intro-actions">
          <span>{sources.length} 个数据源</span>
          <button
            className="studio-button secondary"
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
          >
            <ReloadOutlined spin={loading} /> 刷新
          </button>
          <button
            className="studio-button primary"
            type="button"
            onClick={() => {
              setError(null);
              setDraft(emptyDraft());
            }}
          >
            <PlusOutlined /> 新建数据源
          </button>
        </div>
      </div>
      <div className="provider-table-wrap">
        <table className="provider-table schema-source-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>连接器</th>
              <th>端点</th>
              <th>采集范围</th>
              <th>语义模板</th>
              <th>状态</th>
              <th>默认</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {loading && sources.length === 0 ? (
              <tr>
                <td colSpan={8} className="table-empty">
                  正在加载 Schema 源...
                </td>
              </tr>
            ) : null}
            {!loading && sources.length === 0 ? (
              <tr>
                <td colSpan={8} className="table-empty">
                  还没有 Schema 源，请先添加只读数据库连接。
                </td>
              </tr>
            ) : null}
            {sources.map((source) => (
              <tr key={source.id}>
                <td data-label="名称">
                  <div className="provider-name">
                    <span className={`provider-dot${source.enabled ? "" : " is-disabled"}`} />
                    <b>{source.name}</b>
                    <small>{source.managedByEnv ? "ENV MANAGED" : source.id}</small>
                  </div>
                </td>
                <td data-label="连接器">
                  <span className="format-pill">{connectorLabel(source.connector)}</span>
                </td>
                <td data-label="端点">
                  <code title={source.endpoint}>{source.endpoint}</code>
                </td>
                <td data-label="采集范围">
                  <span className="masked-key">
                    {source.tableFilter.length > 0 ? source.tableFilter.join(", ") : "全部业务表"}
                  </span>
                </td>
                <td data-label="语义模板">
                  <span className="format-pill">
                    {source.semanticProfile === "oneapi" ? "oneapi" : "通用"}
                  </span>
                </td>
                <td data-label="状态">
                  <div className="schema-source-status-cell">
                    <span className={`schema-sync-status is-${source.syncStatus}`}>
                      {source.enabled
                        ? source.syncStatus === "ready"
                          ? "已同步"
                          : source.syncStatus === "syncing"
                            ? "同步中"
                            : source.syncStatus === "error"
                              ? "同步失败"
                              : "待同步"
                        : "已停用"}
                    </span>
                    {source.syncStatus === "ready" ? (
                      <small title={source.lastSyncedAt ?? undefined}>
                        {source.tableCount} 表 · {source.relationCount} 关系
                        {source.lastSyncedAt ? ` · ${formatSyncTime(source.lastSyncedAt)}` : ""}
                      </small>
                    ) : source.lastError ? (
                      <small title={source.lastError}>{source.lastError}</small>
                    ) : null}
                  </div>
                </td>
                <td data-label="默认源">
                  {source.isDefault ? (
                    <span className="default-mark">DEFAULT</span>
                  ) : (
                    <button
                      className="set-default-button"
                      type="button"
                      disabled={!source.enabled || defaultingId !== null}
                      onClick={() => void makeDefault(source)}
                    >
                      <StarOutlined />
                      <span>{defaultingId === source.id ? "设置中" : "设为默认"}</span>
                    </button>
                  )}
                </td>
                <td data-label="操作">
                  <div className="table-actions">
                    <button
                      type="button"
                      title="预览 Schema"
                      aria-label={`预览 ${source.name} Schema`}
                      disabled={!source.enabled || previewingId !== null}
                      onClick={() => void openPreview(source)}
                    >
                      <EyeOutlined spin={previewingId === source.id} />
                    </button>
                    <button
                      type="button"
                      title="同步 Schema"
                      aria-label={`同步 ${source.name} Schema`}
                      disabled={!source.enabled || syncingId !== null}
                      onClick={() => void synchronize(source)}
                    >
                      <SyncOutlined spin={syncingId === source.id} />
                    </button>
                    <button
                      type="button"
                      title="复制配置"
                      aria-label={`复制 ${source.name}`}
                      disabled={duplicatingId !== null}
                      onClick={() => void duplicate(source)}
                    >
                      <CopyOutlined spin={duplicatingId === source.id} />
                    </button>
                    <button
                      type="button"
                      title="测试连接"
                      aria-label={`测试 ${source.name} 连接`}
                      disabled={testingId !== null}
                      onClick={() => void probeExisting(source)}
                    >
                      <DatabaseOutlined spin={testingId === source.id} />
                    </button>
                    {!source.managedByEnv ? (
                      <button
                        type="button"
                        title="编辑"
                        aria-label={`编辑 ${source.name}`}
                        onClick={() => edit(source)}
                      >
                        <EditOutlined />
                      </button>
                    ) : null}
                    {!source.managedByEnv && !source.isDefault ? (
                      <button
                        type="button"
                        title="删除"
                        aria-label={`删除 ${source.name}`}
                        onClick={() => {
                          if (window.confirm(`删除 Schema 源“${source.name}”？`)) {
                            void removeSchemaSource(source.id)
                              .then(refresh)
                              .catch((reason) =>
                                setError(reason instanceof Error ? reason.message : "删除失败"),
                              );
                          }
                        }}
                      >
                        <DeleteOutlined />
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {draft
        ? createPortal(
            <SchemaSourceModal
              draft={draft}
              setDraft={setDraft}
              saving={saving}
              error={error}
              onCancel={() => setDraft(null)}
              onSubmit={(input) => void submit(input)}
            />,
            document.body,
          )
        : null}
      {preview
        ? createPortal(
            <SchemaCatalogModal preview={preview} onClose={() => setPreview(null)} />,
            document.body,
          )
        : null}
    </main>
  );
}

function SchemaCatalogModal({
  preview,
  onClose,
}: {
  preview: SchemaCatalogPreview;
  onClose: () => void;
}) {
  return (
    <div
      className="settings-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="settings-modal schema-catalog-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="schema-catalog-modal-title"
      >
        <div className="settings-modal-head">
          <div>
            <span className="settings-kicker">SCHEMA CATALOG</span>
            <h2 id="schema-catalog-modal-title">{preview.database}</h2>
            <p>
              {preview.tables.length} 张表 · {preview.relationCount} 条关系 ·{" "}
              {new Date(preview.collectedAt).toLocaleString()}
            </p>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose}>
            <CloseOutlined />
          </button>
        </div>
        <div className="schema-catalog-list">
          {preview.tables.map((table) => (
            <div className="schema-catalog-row" key={table.name}>
              <div>
                <strong>{table.name}</strong>
                <span>{table.comment || "无表注释"}</span>
              </div>
              <span>{table.columnCount} 列</span>
              <span>~{table.rows} 行</span>
            </div>
          ))}
        </div>
        <div className="settings-modal-actions">
          <button className="studio-button primary" type="button" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
}

function SchemaSourceModal({
  draft,
  setDraft,
  saving,
  error,
  onCancel,
  onSubmit,
}: {
  draft: SchemaSourceDraft;
  setDraft: (draft: SchemaSourceDraft) => void;
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (input: SchemaSourceDraft) => void;
}) {
  const [filterText, setFilterText] = useState(draft.tableFilter.join(", "));
  const [connectionMode, setConnectionMode] = useState<"fields" | "url">("fields");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ type: "ok" | "error"; text: string } | null>(null);
  const patch = (value: Partial<SchemaSourceDraft>) => {
    setTestResult(null);
    setDraft({ ...draft, ...value });
  };
  const { host, port, username, password, connectionString, ...common } = draft;
  const input: SchemaSourceDraft =
    connectionMode === "fields"
      ? { ...common, host, port, username, password }
      : { ...common, connectionString };
  const validConnection =
    connectionMode === "fields"
      ? Boolean(
          host?.trim() &&
          typeof port === "number" &&
          Number.isInteger(port) &&
          port >= 1 &&
          port <= 65535 &&
          username?.trim() &&
          draft.databaseName.trim(),
        )
      : Boolean(draft.id || connectionString?.trim());
  const changeConnector = (connector: SchemaSourceConnector) => {
    const previousDefault = draft.connector === "postgresql" ? 5432 : 3306;
    const nextDefault = connector === "postgresql" ? 5432 : 3306;
    patch({
      connector,
      port: draft.port === previousDefault ? nextDefault : draft.port,
      schemaName: connector === "postgresql" ? draft.schemaName : "",
    });
  };
  const changeFilters = (value: string) => {
    setFilterText(value);
    patch({
      tableFilter: value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    });
  };
  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testSchemaSource(input);
      setTestResult({
        type: "ok",
        text: `连接成功：${result.database} · ${connectorLabel(draft.connector)} ${result.version}`,
      });
    } catch (reason) {
      setTestResult({ type: "error", text: reason instanceof Error ? reason.message : "连接失败" });
    } finally {
      setTesting(false);
    }
  };
  const canSubmit = Boolean(draft.name.trim() && validConnection);

  return (
    <div
      className="settings-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <form
        className="settings-modal schema-source-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="schema-source-modal-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit && !saving && !testing) onSubmit(input);
        }}
      >
        <div className="settings-modal-head">
          <div>
            <span className="settings-kicker">SCHEMA SOURCE</span>
            <h2 id="schema-source-modal-title">{draft.id ? "编辑数据源" : "新建数据源"}</h2>
          </div>
          <button type="button" aria-label="关闭" onClick={onCancel}>
            <CloseOutlined />
          </button>
        </div>
        <div className="settings-modal-fields">
          <label className="studio-field">
            <span>名称</span>
            <input
              required
              value={draft.name}
              onChange={(event) => patch({ name: event.target.value })}
              placeholder="例如 生产运营库"
            />
          </label>
          <label className="studio-field">
            <span>数据库类型</span>
            <select
              value={draft.connector}
              onChange={(event) => changeConnector(event.target.value as SchemaSourceConnector)}
            >
              <option value="mysql">MySQL</option>
              <option value="postgresql">PostgreSQL</option>
            </select>
          </label>
          <div className="schema-source-connection-mode">
            <span>连接配置</span>
            <div role="group" aria-label="连接配置方式">
              {(
                [
                  ["fields", "分项填写"],
                  ["url", "连接串"],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={connectionMode === mode}
                  onClick={() => {
                    setConnectionMode(mode);
                    setTestResult(null);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {connectionMode === "fields" ? (
            <>
              <label className="studio-field">
                <span>IP / 主机名</span>
                <input
                  required
                  value={draft.host ?? ""}
                  onChange={(event) => patch({ host: event.target.value })}
                  placeholder="192.168.1.10 或 db.example.com"
                  autoComplete="off"
                />
              </label>
              <label className="studio-field">
                <span>端口</span>
                <input
                  required
                  type="number"
                  min={1}
                  max={65535}
                  step={1}
                  value={draft.port ?? ""}
                  onChange={(event) =>
                    patch({
                      port: event.target.value === "" ? undefined : Number(event.target.value),
                    })
                  }
                  placeholder={draft.connector === "postgresql" ? "5432" : "3306"}
                />
              </label>
              <label className="studio-field">
                <span>
                  账户 <small>建议使用只读账号</small>
                </span>
                <input
                  required
                  value={draft.username ?? ""}
                  onChange={(event) => patch({ username: event.target.value })}
                  placeholder="readonly"
                  autoComplete="off"
                />
              </label>
              <label className="studio-field">
                <span>
                  密码 <small>{draft.id ? "留空保持原密码" : "无密码时可留空"}</small>
                </span>
                <input
                  type="password"
                  value={draft.password ?? ""}
                  onChange={(event) => patch({ password: event.target.value })}
                  placeholder={draft.id ? "已保存的密码" : "请输入密码"}
                  autoComplete="new-password"
                />
              </label>
            </>
          ) : (
            <label className="studio-field schema-source-connection-field">
              <span>
                连接串 <small>{draft.id ? "留空保持原连接" : "支持附加连接参数"}</small>
              </span>
              <input
                type="password"
                required={!draft.id}
                value={draft.connectionString ?? ""}
                onChange={(event) => patch({ connectionString: event.target.value })}
                placeholder={connectionPlaceholder(draft.connector)}
                autoComplete="new-password"
              />
            </label>
          )}
          <label className="studio-field">
            <span>
              数据库名称 {connectionMode === "url" ? <small>可覆盖连接串中的库名</small> : null}
            </span>
            <input
              required={connectionMode === "fields"}
              value={draft.databaseName}
              onChange={(event) => patch({ databaseName: event.target.value })}
              placeholder={connectionMode === "fields" ? "例如 analytics" : "可选"}
            />
          </label>
          {draft.connector === "postgresql" ? (
            <label className="studio-field">
              <span>
                Schema <small>默认 public</small>
              </span>
              <input
                value={draft.schemaName}
                onChange={(event) => patch({ schemaName: event.target.value })}
                placeholder="public"
              />
            </label>
          ) : null}
          <label className="studio-field">
            <span>语义模板</span>
            <select
              value={draft.semanticProfile}
              onChange={(event) =>
                patch({
                  semanticProfile: event.target.value as SchemaSourceDraft["semanticProfile"],
                })
              }
            >
              <option value="generic">通用 Schema</option>
              <option value="oneapi">oneapi 运营库</option>
            </select>
          </label>
          <label className="studio-field schema-source-filter-field">
            <span>
              表范围 <small>逗号分隔，支持 * 通配符；留空采集全部业务表</small>
            </span>
            <textarea
              value={filterText}
              onChange={(event) => changeFilters(event.target.value)}
              placeholder="users, orders, report_*"
            />
          </label>
          <label className="toggle-field">
            <span className="toggle-field__copy">
              <b>启用数据源</b>
              <small>停用后不会出现在问数选择器</small>
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
          {testResult ? (
            <div className={`schema-source-test-result is-${testResult.type}`}>
              {testResult.text}
            </div>
          ) : null}
          {error ? (
            <div className="schema-source-test-result is-error" role="alert">
              {error}
            </div>
          ) : null}
        </div>
        <div className="settings-modal-actions schema-source-modal-actions">
          <button
            className="studio-button secondary"
            type="button"
            disabled={saving || testing || !validConnection}
            onClick={() => void testConnection()}
          >
            <DatabaseOutlined spin={testing} /> {testing ? "测试中" : "测试连接"}
          </button>
          <span />
          <button className="studio-button secondary" type="button" onClick={onCancel}>
            取消
          </button>
          <button
            className="studio-button primary"
            type="submit"
            disabled={saving || testing || !canSubmit}
          >
            <SaveOutlined /> {saving ? "保存中" : "保存数据源"}
          </button>
        </div>
      </form>
    </div>
  );
}
