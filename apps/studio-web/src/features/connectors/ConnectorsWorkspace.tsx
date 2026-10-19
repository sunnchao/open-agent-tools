import { useCallback, useEffect, useState } from "react";
import {
  BranchesOutlined,
  DeleteOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
  SyncOutlined,
} from "../../lib/icons.js";
import {
  CONNECTOR_BASE_URL_HINTS,
  CONNECTOR_CREDENTIAL_FIELDS,
  CONNECTOR_TYPE_LABELS,
  CONNECTOR_TYPES,
  fetchConnectorRuns,
  fetchConnectors,
  linesToPatterns,
  patternsToText,
  removeConnector,
  saveConnector,
  statusLabel,
  syncConnector,
  type ConnectorDraft,
  type ConnectorRecord,
  type ConnectorSyncRun,
  type ConnectorType,
} from "./api.js";

interface FormState {
  id?: string;
  name: string;
  type: ConnectorType;
  baseUrl: string;
  credentials: Record<string, string>;
  includeText: string;
  excludeText: string;
  maxDocuments: string;
  enabled: boolean;
}

interface Notice {
  type: "success" | "error" | "info";
  text: string;
}

function emptyForm(): FormState {
  return {
    name: "",
    type: "http",
    baseUrl: "",
    credentials: {},
    includeText: "",
    excludeText: "",
    maxDocuments: "",
    enabled: true,
  };
}

function formFromRecord(record: ConnectorRecord): FormState {
  return {
    id: record.id,
    name: record.name,
    type: record.type,
    baseUrl: record.baseUrl ?? "",
    // 凭据值不回传前端,留空即保持服务端已有值。
    credentials: {},
    includeText: patternsToText(record.filter.include),
    excludeText: patternsToText(record.filter.exclude),
    maxDocuments: record.filter.maxDocuments ? String(record.filter.maxDocuments) : "",
    enabled: record.enabled,
  };
}

function draftFromForm(form: FormState): ConnectorDraft {
  const maxDocuments = Number(form.maxDocuments);
  return {
    ...(form.id ? { id: form.id } : {}),
    name: form.name.trim(),
    type: form.type,
    baseUrl: form.baseUrl,
    credentials: form.credentials,
    filter: {
      include: linesToPatterns(form.includeText),
      exclude: linesToPatterns(form.excludeText),
      maxDocuments:
        Number.isFinite(maxDocuments) && maxDocuments > 0 ? Math.floor(maxDocuments) : null,
    },
    enabled: form.enabled,
  };
}

export function ConnectorsWorkspace() {
  const [connectors, setConnectors] = useState<ConnectorRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runs, setRuns] = useState<ConnectorSyncRun[]>([]);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const selected = connectors.find((item) => item.id === selectedId) ?? null;

  const refresh = useCallback(async () => {
    try {
      const list = await fetchConnectors();
      setConnectors(list);
      return list;
    } catch (error) {
      setNotice({ type: "error", text: errorText(error) });
      return [];
    }
  }, []);

  const loadRuns = useCallback(async (id: string) => {
    try {
      setRuns(await fetchConnectorRuns(id));
    } catch {
      setRuns([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (selectedId) void loadRuns(selectedId);
    else setRuns([]);
  }, [selectedId, loadRuns]);

  const selectConnector = (record: ConnectorRecord) => {
    setSelectedId(record.id);
    setForm(formFromRecord(record));
    setNotice(null);
  };

  const startCreate = () => {
    setSelectedId(null);
    setForm(emptyForm());
    setRuns([]);
    setNotice(null);
  };

  const save = async () => {
    if (!form.name.trim()) {
      setNotice({ type: "error", text: "请填写连接器名称" });
      return;
    }
    setBusy("save");
    try {
      const saved = await saveConnector(draftFromForm(form));
      const list = await refresh();
      setSelectedId(saved.id);
      const record = list.find((item) => item.id === saved.id) ?? saved;
      setForm(formFromRecord(record));
      setNotice({ type: "success", text: `已保存连接器「${saved.name}」` });
    } catch (error) {
      setNotice({ type: "error", text: errorText(error) });
    } finally {
      setBusy(null);
    }
  };

  const runSync = async () => {
    if (!selected) return;
    setBusy("sync");
    try {
      const result = await syncConnector(selected.id);
      await refresh();
      await loadRuns(selected.id);
      setNotice({
        type: result.run.status === "error" ? "error" : "success",
        text: runSummary(result.run),
      });
    } catch (error) {
      setNotice({ type: "error", text: errorText(error) });
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!selected) return;
    setBusy("delete");
    try {
      await removeConnector(selected.id);
      await refresh();
      startCreate();
      setNotice({ type: "success", text: "连接器已删除" });
    } catch (error) {
      setNotice({ type: "error", text: errorText(error) });
    } finally {
      setBusy(null);
    }
  };

  const credentialFields = CONNECTOR_CREDENTIAL_FIELDS[form.type];

  return (
    <section className="domain-workspace connectors-workspace">
      <header className="domain-header">
        <div>
          <p className="domain-eyebrow">Knowledge Connectors / A6</p>
          <h1>文档连接器</h1>
        </div>
        <div className="domain-header-actions">
          <button className="studio-button secondary" type="button" onClick={startCreate}>
            <PlusOutlined /> 新建
          </button>
          <button
            className="studio-button secondary"
            type="button"
            disabled={busy !== null}
            onClick={() => void refresh()}
          >
            <ReloadOutlined /> 刷新
          </button>
        </div>
      </header>

      {notice ? (
        <div className={`workspace-notice ${notice.type}`} role="status">
          {notice.text}
        </div>
      ) : null}

      <div className="connectors-layout">
        <aside className="connectors-list">
          <div className="panel-heading">
            <span>连接器</span>
            <small>{connectors.length}</small>
          </div>
          {connectors.length === 0 ? (
            <p className="connectors-empty">还没有连接器,点击「新建」配置一个知识源。</p>
          ) : (
            <ul>
              {connectors.map((record) => (
                <li key={record.id}>
                  <button
                    type="button"
                    className={`connectors-item${record.id === selectedId ? " is-active" : ""}`}
                    onClick={() => selectConnector(record)}
                  >
                    <span className={`connectors-dot is-${record.lastStatus ?? "idle"}`} />
                    <span className="connectors-item__body">
                      <span className="connectors-item__name">{record.name}</span>
                      <span className="connectors-item__meta">
                        {CONNECTOR_TYPE_LABELS[record.type]}
                        {record.enabled ? "" : " · 已停用"}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <div className="connectors-detail">
          <div className="panel-heading">
            <span>
              <BranchesOutlined /> {form.id ? "编辑连接器" : "新建连接器"}
            </span>
            {selected ? (
              <small>
                最近同步:{" "}
                {selected.lastSyncedAt ? new Date(selected.lastSyncedAt).toLocaleString() : "—"} ·{" "}
                {statusLabel(selected.lastStatus)}
              </small>
            ) : null}
          </div>

          <div className="connectors-form">
            <label className="studio-field">
              <span>名称</span>
              <input
                value={form.name}
                placeholder="例如:HR 知识库"
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </label>

            <label className="studio-field">
              <span>类型</span>
              <select
                value={form.type}
                onChange={(event) =>
                  setForm({ ...form, type: event.target.value as ConnectorType, credentials: {} })
                }
              >
                {CONNECTOR_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {CONNECTOR_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
              <small className="field-help">{CONNECTOR_BASE_URL_HINTS[form.type]}</small>
            </label>

            <label className="studio-field">
              <span>Base URL / 路径</span>
              <input
                value={form.baseUrl}
                placeholder={CONNECTOR_BASE_URL_HINTS[form.type]}
                onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
              />
            </label>

            {credentialFields.map((field) => (
              <label className="studio-field" key={field.key}>
                <span>
                  {field.label}
                  {form.id && selected?.credentialKeys.includes(field.key) ? (
                    <small>已配置,留空保持不变</small>
                  ) : null}
                </span>
                <input
                  type={field.secret ? "password" : "text"}
                  value={form.credentials[field.key] ?? ""}
                  placeholder={field.placeholder}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      credentials: { ...form.credentials, [field.key]: event.target.value },
                    })
                  }
                />
              </label>
            ))}

            <label className="studio-field">
              <span>
                包含规则 <small>每行一条,支持 * 通配</small>
              </span>
              <textarea
                value={form.includeText}
                placeholder={"hr/*\n*.md"}
                onChange={(event) => setForm({ ...form, includeText: event.target.value })}
              />
            </label>

            <label className="studio-field">
              <span>
                排除规则 <small>每行一条</small>
              </span>
              <textarea
                value={form.excludeText}
                placeholder={"*draft*"}
                onChange={(event) => setForm({ ...form, excludeText: event.target.value })}
              />
            </label>

            <label className="studio-field">
              <span>单次最大文档数</span>
              <input
                value={form.maxDocuments}
                inputMode="numeric"
                placeholder="留空表示不限"
                onChange={(event) => setForm({ ...form, maxDocuments: event.target.value })}
              />
            </label>

            <label className="connectors-toggle">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
              />
              启用该连接器
            </label>

            <div className="connectors-form-actions">
              <button
                className="studio-button primary"
                type="button"
                disabled={busy !== null}
                onClick={() => void save()}
              >
                <SaveOutlined /> {busy === "save" ? "保存中..." : "保存"}
              </button>
              <button
                className="studio-button secondary"
                type="button"
                disabled={!selected || busy !== null}
                onClick={() => void runSync()}
              >
                <SyncOutlined /> {busy === "sync" ? "同步中..." : "立即同步"}
              </button>
              <button
                className="studio-button secondary"
                type="button"
                disabled={!selected || busy !== null}
                onClick={() => void remove()}
              >
                <DeleteOutlined /> 删除
              </button>
            </div>
          </div>

          <div className="connectors-runs">
            <div className="panel-heading">
              <span>最近同步结果</span>
              <small>{runs.length}</small>
            </div>
            {runs.length === 0 ? (
              <p className="connectors-empty">尚无同步记录,点击「立即同步」试运行一次。</p>
            ) : (
              <table className="connectors-runs__table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>状态</th>
                    <th>拉取</th>
                    <th>入库</th>
                    <th>跳过</th>
                    <th>失败</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.id}>
                      <td>{new Date(run.startedAt).toLocaleString()}</td>
                      <td>
                        <span className={`connectors-status is-${run.status}`}>
                          {statusLabel(run.status)}
                        </span>
                      </td>
                      <td>{run.pulled}</td>
                      <td>{run.ingested}</td>
                      <td>{run.skipped}</td>
                      <td>{run.failed}</td>
                      <td className="connectors-runs__note">{runNote(run)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function runSummary(run: ConnectorSyncRun): string {
  if (run.error) return `同步失败:${run.error}`;
  return `拉取 ${run.pulled} 篇,入库 ${run.ingested},跳过 ${run.skipped},失败 ${run.failed}`;
}

function runNote(run: ConnectorSyncRun): string {
  if (run.error) return run.error;
  if (run.failures.length > 0) {
    return run.failures.map((failure) => `${failure.externalId}: ${failure.reason}`).join("; ");
  }
  return "—";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
