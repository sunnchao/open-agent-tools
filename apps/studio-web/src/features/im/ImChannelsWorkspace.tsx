import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  CloseOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
} from "../../lib/icons.js";
import {
  fetchImChannels,
  removeImChannel,
  restartImChannel,
  saveImChannel,
  IM_PLATFORM_LABELS,
  IM_PLATFORMS,
  type ImChannelMetadata,
  type ImPlatform,
} from "./api.js";

type Draft = {
  id?: string;
  name: string;
  platform: ImPlatform;
  appId: string;
  appSecret: string;
  encryptKey: string;
  ragSources: string[];
  ragTopK: number;
  requireMention: boolean;
  enabled: boolean;
};

const emptyDraft = (): Draft => ({
  name: "",
  platform: "feishu",
  appId: "",
  appSecret: "",
  encryptKey: "",
  ragSources: [],
  ragTopK: 5,
  requireMention: true,
  enabled: true,
});

export function ImChannelsSection() {
  const [channels, setChannels] = useState<ImChannelMetadata[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [restartingId, setRestartingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      setChannels(await fetchImChannels());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "IM 渠道加载失败");
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
      await saveImChannel(draft);
      setDraft(null);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "IM 渠道保存失败");
    } finally {
      setSaving(false);
    }
  };

  const edit = (channel: ImChannelMetadata) =>
    setDraft({
      id: channel.id,
      name: channel.name,
      platform: channel.platform,
      appId: channel.appId,
      appSecret: "",
      encryptKey: "",
      ragSources: channel.ragSources,
      ragTopK: channel.ragTopK,
      requireMention: channel.requireMention,
      enabled: channel.enabled,
    });

  const restart = async (channel: ImChannelMetadata) => {
    setRestartingId(channel.id);
    setError(null);
    try {
      await restartImChannel(channel.id);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "渠道重启失败");
    } finally {
      setRestartingId(null);
    }
  };

  return (
    <main className="settings-content">
      {error ? <div className="settings-alert">{error}</div> : null}
      <div className="settings-intro">
        <div>
          <span className="settings-kicker">COLLABORATION ENTRY</span>
          <h2>机器人渠道</h2>
        </div>
        <span>{channels.length} 个渠道</span>
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
            <PlusOutlined /> <span>新建渠道</span>
          </button>
        </div>
      </div>
      <div className="provider-table-wrap">
        <table className="provider-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>平台</th>
              <th>App ID</th>
              <th>知识库</th>
              <th>状态</th>
              <th>连接</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {loading && channels.length === 0 ? (
              <tr>
                <td colSpan={7} className="table-empty">
                  正在加载 IM 渠道...
                </td>
              </tr>
            ) : null}
            {!loading && channels.length === 0 ? (
              <tr>
                <td colSpan={7} className="table-empty">
                  还没有 IM 渠道
                </td>
              </tr>
            ) : null}
            {channels.map((channel) => (
              <tr key={channel.id}>
                <td data-label="名称">
                  <div className="provider-name">
                    <span className={`provider-dot${channel.enabled ? "" : " is-disabled"}`} />
                    <b>{channel.name}</b>
                    <small>{channel.id.slice(0, 8)}</small>
                  </div>
                </td>
                <td data-label="平台">
                  <span className="format-pill">{IM_PLATFORM_LABELS[channel.platform]}</span>
                </td>
                <td data-label="App ID">
                  <code title={channel.appId}>{channel.appId}</code>
                </td>
                <td data-label="知识库">
                  <span className="model-count">{channel.ragSources.length}</span>
                  <small className="channel-sources" title={channel.ragSources.join(", ")}>
                    {channel.ragSources.length > 0 ? channel.ragSources.join(", ") : "未绑定"}
                  </small>
                </td>
                <td data-label="状态">
                  <span className={`status-pill${channel.enabled ? " is-enabled" : ""}`}>
                    {channel.enabled ? "启用" : "停用"}
                  </span>
                </td>
                <td data-label="连接">
                  <span className={`status-pill${channel.connected ? " is-enabled" : ""}`}>
                    {channel.connected ? "已连接" : channel.error ? "异常" : "未连接"}
                  </span>
                </td>
                <td data-label="操作">
                  <div className="table-actions">
                    <button
                      type="button"
                      title="重启连接"
                      aria-label={`重启 ${channel.name}`}
                      onClick={() => void restart(channel)}
                      disabled={restartingId !== null}
                    >
                      <ReloadOutlined spin={restartingId === channel.id} />
                    </button>
                    <button
                      type="button"
                      title="编辑"
                      aria-label={`编辑 ${channel.name}`}
                      onClick={() => edit(channel)}
                    >
                      <EditOutlined />
                    </button>
                    <button
                      type="button"
                      title="删除"
                      aria-label={`删除 ${channel.name}`}
                      onClick={() => {
                        if (window.confirm(`删除渠道「${channel.name}」？`))
                          void removeImChannel(channel.id)
                            .then(refresh)
                            .catch((reason) =>
                              setError(reason instanceof Error ? reason.message : "删除失败"),
                            );
                      }}
                    >
                      <DeleteOutlined />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {draft
        ? createPortal(
            <ImChannelModal
              draft={draft}
              setDraft={setDraft}
              saving={saving}
              onCancel={() => setDraft(null)}
              onSubmit={() => void submit()}
            />,
            document.body,
          )
        : null}
    </main>
  );
}

function ImChannelModal({
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
  const [sourceInput, setSourceInput] = useState("");
  const patch = (value: Partial<Draft>) => setDraft({ ...draft, ...value });
  const addSource = () => {
    const source = sourceInput.trim();
    if (source && !draft.ragSources.includes(source))
      patch({ ragSources: [...draft.ragSources, source] });
    setSourceInput("");
  };

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
        aria-labelledby="im-channel-modal-title"
      >
        <div className="settings-modal-head">
          <div>
            <span className="settings-kicker">IM CHANNEL EDITOR</span>
            <h2 id="im-channel-modal-title">{draft.id ? "编辑渠道" : "新建渠道"}</h2>
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
              placeholder="例如 研发群机器人"
            />
          </label>
          <label className="studio-field">
            <span>平台</span>
            <select
              value={draft.platform}
              onChange={(event) => patch({ platform: event.target.value as ImPlatform })}
            >
              {IM_PLATFORMS.map((platform) => (
                <option key={platform} value={platform}>
                  {IM_PLATFORM_LABELS[platform]}
                </option>
              ))}
            </select>
          </label>
          <label className="studio-field">
            <span>App ID</span>
            <input
              value={draft.appId}
              onChange={(event) => patch({ appId: event.target.value })}
              placeholder="cli_xxxxxxxx"
            />
          </label>
          <label className="studio-field">
            <span>
              App Secret <small>{draft.id ? "留空保持不变" : "必填"}</small>
            </span>
            <input
              type="password"
              value={draft.appSecret}
              onChange={(event) => patch({ appSecret: event.target.value })}
              autoComplete="new-password"
            />
          </label>
          <label className="studio-field">
            <span>
              事件解密密钥 <small>可选，飞书 Encrypt Key / 钉钉加解密</small>
            </span>
            <input
              type="password"
              value={draft.encryptKey}
              onChange={(event) => patch({ encryptKey: event.target.value })}
              autoComplete="new-password"
            />
          </label>
          <div className="studio-field">
            <span>知识库绑定</span>
            <div className="model-editor">
              <div className="model-tags">
                {draft.ragSources.map((source) => (
                  <span className="model-tag" key={source}>
                    {source}
                    <button
                      type="button"
                      aria-label={`移除 ${source}`}
                      onClick={() =>
                        patch({ ragSources: draft.ragSources.filter((item) => item !== source) })
                      }
                    >
                      <CloseOutlined />
                    </button>
                  </span>
                ))}
                {draft.ragSources.length === 0 ? (
                  <small>留空则机器人退化为纯 LLM 问答</small>
                ) : null}
              </div>
              <div className="model-editor-input">
                <input
                  value={sourceInput}
                  onChange={(event) => setSourceInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addSource();
                    }
                  }}
                  placeholder="知识库 source 名，回车添加"
                />
                <button type="button" onClick={addSource}>
                  <PlusOutlined />
                </button>
              </div>
            </div>
          </div>
          <label className="studio-field">
            <span>
              检索条数 <small>1–20</small>
            </span>
            <input
              type="number"
              min={1}
              max={20}
              value={draft.ragTopK}
              onChange={(event) =>
                patch({ ragTopK: Math.min(20, Math.max(1, Number(event.target.value) || 5)) })
              }
            />
          </label>
          <label className="toggle-field">
            <span className="toggle-field__copy">
              <b>群聊需 @ 机器人</b>
              <small>关闭后群内所有消息都会响应（慎用）</small>
            </span>
            <span className="settings-switch">
              <input
                type="checkbox"
                checked={draft.requireMention}
                onChange={(event) => patch({ requireMention: event.target.checked })}
              />
              <span aria-hidden="true" />
            </span>
          </label>
          <label className="toggle-field">
            <span className="toggle-field__copy">
              <b>启用渠道</b>
              <small>停用后立即断开机器人连接</small>
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
            <SaveOutlined /> {saving ? "保存中" : "保存渠道"}
          </button>
        </div>
      </div>
    </div>
  );
}
