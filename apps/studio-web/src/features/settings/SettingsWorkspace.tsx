import { useEffect, useState } from "react";
import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
  SettingOutlined,
  StarOutlined,
} from "@ant-design/icons";
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
import { PROVIDER_FORMATS, PROVIDER_FORMAT_LABELS } from "../providers/api.js";

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

export function SettingsWorkspace() {
  const [providers, setProviders] = useState<ProviderMetadata[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [defaultingId, setDefaultingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    void refresh();
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
            <SettingOutlined /> 模型 Provider
          </h1>
          <p className="domain-subtitle">集中管理 OpenAI 兼容服务和可用模型。</p>
        </div>
        <div className="domain-header-actions">
          <button
            className="studio-button secondary"
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
          >
            <ReloadOutlined /> 刷新
          </button>
          <button
            className="studio-button primary"
            type="button"
            onClick={() => setDraft(emptyDraft())}
          >
            <PlusOutlined /> 新建 Provider
          </button>
        </div>
      </header>
      <div className="settings-body">
        <aside className="settings-sections">
          <div className="settings-section is-active">
            <span>01</span>
            <b>模型 Provider</b>
            <small>路由与模型目录</small>
          </div>
          <div className="settings-section is-muted">
            <span>02</span>
            <b>更多设置</b>
            <small>即将开放</small>
          </div>
        </aside>
        <main className="settings-content">
          {error ? <div className="settings-alert">{error}</div> : null}
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
                    <td>
                      <div className="provider-name">
                        <span className="provider-dot" />
                        <b>{provider.name}</b>
                        <small>{provider.id}</small>
                      </div>
                    </td>
                    <td>
                      <code>{provider.baseUrl}</code>
                    </td>
                    <td>
                      <span className="masked-key">{provider.apiKeyMasked ?? "未配置"}</span>
                    </td>
                    <td>
                      <span className="format-pill">{PROVIDER_FORMAT_LABELS[provider.format]}</span>
                    </td>
                    <td>
                      <span className="model-count">{provider.models.length}</span>
                    </td>
                    <td>
                      <span className={`status-pill${provider.enabled ? " is-enabled" : ""}`}>
                        {provider.enabled ? "启用" : "停用"}
                      </span>
                    </td>
                    <td>
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
                    <td>
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
                                    setError(reason instanceof Error ? reason.message : "删除失败"),
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
      </div>
      {draft ? (
        <ProviderModal
          draft={draft}
          setDraft={setDraft}
          saving={saving}
          onCancel={() => setDraft(null)}
          onSubmit={() => void submit()}
        />
      ) : null}
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
            ×
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
                      ×
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
                  <ReloadOutlined /> {fetching ? "获取中" : "自动获取"}
                </button>
              </div>
            </div>
          </div>
          <label className="toggle-field">
            <span>
              <b>启用 Provider</b>
              <small>禁用后不会出现在 Workflow 选择器</small>
            </span>
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => patch({ enabled: event.target.checked })}
            />
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
