import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  AuditOutlined,
  CheckOutlined,
  CloseOutlined,
  CopyOutlined,
  DeleteOutlined,
  KeyOutlined,
  LoadingOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  UserOutlined,
} from "../../lib/icons.js";
import {
  createApiKey,
  createClient,
  deleteGrant,
  listApiKeys,
  listAuditEvents,
  listBuilds,
  listClients,
  listGrants,
  listVersions,
  revokeApiKey,
  upsertGrant,
  type ApiClientRecord,
  type ApiKeyRecord,
  type AuditEventRecord,
  type BuildJobSummary,
  type ClientGrantRecord,
  type McpScope,
  type McpService,
} from "./api.js";
import {
  constrainGrantScopes,
  grantCapabilities,
  supportsGrantScope,
  type GrantCapabilities,
} from "./grantCapabilities.js";

export type McpManagementView = "services" | "builds" | "clients" | "audit";

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

function Notice({ error, notice }: { error: string; notice?: string }) {
  if (!error && !notice) return null;
  return (
    <div className={`workspace-notice ${error ? "error" : "success"}`} role="status">
      {error || notice}
    </div>
  );
}

function Empty({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="operations-empty">
      {icon}
      <p>{text}</p>
    </div>
  );
}

function OperationDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="studio-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="studio-dialog operations-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <h2>{title}</h2>
          <button type="button" aria-label="关闭" onClick={onClose}>
            <CloseOutlined />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
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

  return (
    <div className="mcp-operations-view">
      <div className="operations-toolbar">
        <div>
          <b>构建任务</b>
          <span>
            {visible.length} / {builds.length}
          </span>
        </div>
        <label className="compact-select">
          <span>状态</span>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as typeof status)}
          >
            <option value="ALL">全部</option>
            <option value="QUEUED">排队中</option>
            <option value="RUNNING">执行中</option>
            <option value="SUCCEEDED">成功</option>
            <option value="FAILED">失败</option>
          </select>
        </label>
        <button
          className="icon-command"
          type="button"
          title="刷新"
          aria-label="刷新"
          onClick={() => void load()}
        >
          <ReloadOutlined />
        </button>
      </div>
      <Notice error={error} />
      {loading ? <Empty icon={<LoadingOutlined spin />} text="正在读取构建任务" /> : null}
      {!loading && visible.length === 0 ? (
        <Empty icon={<AuditOutlined />} text="暂无构建记录" />
      ) : null}
      {!loading && visible.length > 0 ? (
        <div className="operations-table build-table" role="table" aria-label="构建任务">
          <div className="operations-table-head" role="row">
            <span>服务 / 版本</span>
            <span>类型</span>
            <span>阶段</span>
            <span>状态</span>
            <span>更新时间</span>
          </div>
          {visible.map((item) => (
            <div className="operations-table-row" role="row" key={item.id}>
              <span>
                <b>{item.serviceName}</b>
                <small>v{item.versionNumber}</small>
              </span>
              <code>{item.kind}</code>
              <span>
                <b>{item.stage}</b>
                <small>{item.errorCode ?? `第 ${item.attempt} 次`}</small>
              </span>
              <span className={`operation-status status-${item.status.toLowerCase()}`}>
                {item.status}
              </span>
              <time dateTime={item.updatedAt}>{formatDate(item.updatedAt)}</time>
            </div>
          ))}
        </div>
      ) : null}
    </div>
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
  const [allTools, setAllTools] = useState(initial?.toolNames === null);
  const [allPrompts, setAllPrompts] = useState(initial?.promptNames === null);
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

  return (
    <form
      className="dialog-form"
      onSubmit={(event) => {
        event.preventDefault();
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
      <label className="studio-field">
        <span>服务</span>
        <select
          value={serviceId}
          disabled={Boolean(initial)}
          onChange={(event) => {
            setServiceId(event.target.value);
            setSelectedScopes(new Set(["mcp:connect"]));
            setAllTools(false);
            setAllPrompts(false);
            setToolNames("");
            setPromptNames("");
          }}
        >
          {services.map((service) => (
            <option value={service.id} key={service.id}>
              {service.name}
            </option>
          ))}
        </select>
      </label>
      {capabilityLoading ? <p className="muted-copy">正在读取当前发布版本能力...</p> : null}
      {capabilityError ? <Notice error={capabilityError} /> : null}
      {capabilities && !capabilityError ? (
        <p className="muted-copy">
          {capabilities.versionNumber === null
            ? "当前没有已发布版本"
            : `当前发布版本 v${capabilities.versionNumber} · ${capabilities.toolCount} Tools · ${capabilities.promptCount} Prompts`}
        </p>
      ) : null}
      <fieldset className="grant-fieldset">
        <legend>Scopes</legend>
        <div className="grant-scope-grid">
          {scopes.map((scope) => {
            const supported = capabilities
              ? supportsGrantScope(scope.value, capabilities)
              : scope.value === "mcp:connect";
            const disabled =
              scope.value === "mcp:connect" || capabilityLoading || !capabilities || !supported;
            return (
              <label className={disabled ? "is-disabled" : undefined} key={scope.value}>
                <input
                  type="checkbox"
                  checked={selectedScopes.has(scope.value)}
                  disabled={disabled}
                  onChange={() => toggleScope(scope.value)}
                />
                <span>{scope.label}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <div className="field-grid">
        <label className="studio-field">
          <span>
            Tool 白名单{" "}
            <small>
              <input
                type="checkbox"
                checked={allTools}
                disabled={capabilityLoading || !capabilities || capabilities.toolCount === 0}
                onChange={(event) => setAllTools(event.target.checked)}
              />{" "}
              全部
            </small>
          </span>
          <input
            disabled={
              allTools || capabilityLoading || !capabilities || capabilities.toolCount === 0
            }
            value={toolNames}
            onChange={(event) => setToolNames(event.target.value)}
            placeholder="echo, search"
          />
        </label>
        <label className="studio-field">
          <span>
            Prompt 白名单{" "}
            <small>
              <input
                type="checkbox"
                checked={allPrompts}
                disabled={capabilityLoading || !capabilities || capabilities.promptCount === 0}
                onChange={(event) => setAllPrompts(event.target.checked)}
              />{" "}
              全部
            </small>
          </span>
          <input
            disabled={
              allPrompts || capabilityLoading || !capabilities || capabilities.promptCount === 0
            }
            value={promptNames}
            onChange={(event) => setPromptNames(event.target.value)}
            placeholder="summary, rewrite"
          />
        </label>
      </div>
      <div className="dialog-actions">
        <button className="studio-button secondary" type="button" onClick={onClose}>
          取消
        </button>
        <button
          className="studio-button primary"
          type="submit"
          disabled={
            busy || !serviceId || capabilityLoading || !capabilities || Boolean(capabilityError)
          }
        >
          {busy ? <LoadingOutlined spin /> : <SafetyCertificateOutlined />} 保存授权
        </button>
      </div>
    </form>
  );
}

export function ClientsView({ services }: { services: McpService[] }) {
  const [clients, setClients] = useState<ApiClientRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [grants, setGrants] = useState<ClientGrantRecord[]>([]);
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
      const [nextKeys, nextGrants] = await Promise.all([
        listApiKeys(clientId),
        listGrants(clientId),
      ]);
      setKeys(nextKeys);
      setGrants(nextGrants);
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
    }
  }, [loadAccess, selectedId]);

  const perform = async (success: string, action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      setNotice(success);
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setBusy(false);
    }
  };

  const client = clients.find((item) => item.id === selectedId) ?? null;

  return (
    <div className="mcp-operations-view client-view">
      <div className="operations-toolbar">
        <div>
          <b>API 客户端</b>
          <span>{clients.length} 个客户端</span>
        </div>
        <button
          className="icon-command"
          type="button"
          title="刷新"
          aria-label="刷新"
          onClick={() => void loadClients()}
        >
          <ReloadOutlined />
        </button>
        <button
          className="studio-button primary compact"
          type="button"
          onClick={() => setDialog("client")}
        >
          <PlusOutlined /> 新建客户端
        </button>
      </div>
      <Notice error={error} notice={notice} />
      {loading ? <Empty icon={<LoadingOutlined spin />} text="正在读取客户端" /> : null}
      {!loading && clients.length === 0 ? (
        <Empty icon={<UserOutlined />} text="暂无 API 客户端" />
      ) : null}
      {!loading && clients.length > 0 ? (
        <div className="client-layout">
          <aside className="client-list">
            {clients.map((item) => (
              <button
                type="button"
                className={item.id === selectedId ? "is-active" : ""}
                key={item.id}
                onClick={() => setSelectedId(item.id)}
              >
                <span>
                  <b>{item.name}</b>
                  <small>{item.status}</small>
                </span>
                <code>{item.id.slice(0, 8)}</code>
              </button>
            ))}
          </aside>
          {client ? (
            <div className="client-detail">
              <section className="access-section">
                <header>
                  <div>
                    <h2>API Keys</h2>
                    <p>{keys.filter((key) => key.status === "ACTIVE").length} 个有效 Key</p>
                  </div>
                  <button
                    className="studio-button secondary compact"
                    type="button"
                    onClick={() => setDialog("key")}
                  >
                    <KeyOutlined /> 签发 Key
                  </button>
                </header>
                <div className="operations-table key-table">
                  <div className="operations-table-head">
                    <span>Key ID</span>
                    <span>状态</span>
                    <span>最近使用</span>
                    <span>过期时间</span>
                    <span />
                  </div>
                  {keys.map((key) => (
                    <div className="operations-table-row" key={key.id}>
                      <code>{key.id.slice(0, 12)}</code>
                      <span className={`operation-status status-${key.status.toLowerCase()}`}>
                        {key.status}
                      </span>
                      <time>{formatDate(key.lastUsedAt)}</time>
                      <time>{formatDate(key.expiresAt)}</time>
                      {key.status === "ACTIVE" ? (
                        <button
                          className="icon-command danger"
                          type="button"
                          title="撤销 Key"
                          aria-label="撤销 Key"
                          onClick={() => {
                            if (!window.confirm("撤销这个 API Key？")) return;
                            void perform("API Key 已撤销", async () => {
                              await revokeApiKey(client.id, key.id);
                              await loadAccess(client.id);
                            });
                          }}
                        >
                          <DeleteOutlined />
                        </button>
                      ) : (
                        <span />
                      )}
                    </div>
                  ))}
                  {keys.length === 0 ? <div className="inline-empty">暂无 API Key</div> : null}
                </div>
              </section>
              <section className="access-section">
                <header>
                  <div>
                    <h2>服务授权</h2>
                    <p>{grants.length} 条 Grant</p>
                  </div>
                  <button
                    className="studio-button secondary compact"
                    type="button"
                    onClick={() => {
                      setEditingGrant(undefined);
                      setDialog("grant");
                    }}
                  >
                    <PlusOutlined /> 添加授权
                  </button>
                </header>
                <div className="grant-list">
                  {grants.map((grant) => (
                    <article className="grant-row" key={grant.id}>
                      <div>
                        <b>
                          {services.find((item) => item.id === grant.serviceId)?.name ??
                            grant.serviceId}
                        </b>
                        <small>{grant.scopes.join(" · ")}</small>
                      </div>
                      <div>
                        <span>Tools: {nameFilter(grant.toolNames)}</span>
                        <span>Prompts: {nameFilter(grant.promptNames)}</span>
                      </div>
                      <span className="grant-actions">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingGrant(grant);
                            setDialog("grant");
                          }}
                        >
                          编辑
                        </button>
                        <button
                          className="icon-command danger"
                          type="button"
                          title="删除授权"
                          aria-label="删除授权"
                          onClick={() => {
                            if (!window.confirm("删除这条服务授权？")) return;
                            void perform("服务授权已删除", async () => {
                              await deleteGrant(client.id, grant.serviceId);
                              await loadAccess(client.id);
                            });
                          }}
                        >
                          <DeleteOutlined />
                        </button>
                      </span>
                    </article>
                  ))}
                  {grants.length === 0 ? <div className="inline-empty">暂无服务授权</div> : null}
                </div>
              </section>
            </div>
          ) : null}
        </div>
      ) : null}

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
        <OperationDialog
          title={editingGrant ? "编辑服务授权" : "添加服务授权"}
          onClose={() => setDialog(null)}
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
        </OperationDialog>
      ) : null}
      {rawKey ? (
        <OperationDialog title="API Key 已创建" onClose={() => setRawKey(null)}>
          <div className="dialog-form">
            <p className="muted-copy">原始 Key 仅展示一次。</p>
            <div className="secret-key">
              <code>{rawKey}</code>
              <button
                className="icon-command"
                type="button"
                title="复制"
                aria-label="复制"
                onClick={() => void navigator.clipboard.writeText(rawKey)}
              >
                <CopyOutlined />
              </button>
            </div>
            <div className="dialog-actions">
              <button
                className="studio-button primary"
                type="button"
                onClick={() => setRawKey(null)}
              >
                完成
              </button>
            </div>
          </div>
        </OperationDialog>
      ) : null}
    </div>
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
  return (
    <OperationDialog title={title} onClose={onClose}>
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          const value = String(new FormData(event.currentTarget).get(inputName) ?? "").trim();
          if (value) void onSubmit(value);
        }}
      >
        <label className="studio-field">
          <span>{label}</span>
          <input required name={inputName} />
        </label>
        <div className="dialog-actions">
          <button className="studio-button secondary" type="button" onClick={onClose}>
            取消
          </button>
          <button className="studio-button primary" type="submit" disabled={busy}>
            {busy ? <LoadingOutlined spin /> : <CheckOutlined />} 创建
          </button>
        </div>
      </form>
    </OperationDialog>
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
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get("expiresAt") ?? "");
    void onSubmit(value ? new Date(value).toISOString() : null);
  };
  return (
    <OperationDialog title="签发 API Key" onClose={onClose}>
      <form className="dialog-form" onSubmit={submit}>
        <label className="studio-field">
          <span>
            过期时间 <small>可选</small>
          </span>
          <input type="datetime-local" name="expiresAt" />
        </label>
        <div className="dialog-actions">
          <button className="studio-button secondary" type="button" onClick={onClose}>
            取消
          </button>
          <button className="studio-button primary" type="submit" disabled={busy}>
            {busy ? <LoadingOutlined spin /> : <KeyOutlined />} 签发
          </button>
        </div>
      </form>
    </OperationDialog>
  );
}

export function AuditView() {
  const [events, setEvents] = useState<AuditEventRecord[]>([]);
  const [outcome, setOutcome] = useState<"ALL" | AuditEventRecord["outcome"]>("ALL");
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

  return (
    <div className="mcp-operations-view">
      <div className="operations-toolbar">
        <div>
          <b>审计事件</b>
          <span>{events.length} 条最近记录</span>
        </div>
        <label className="compact-select">
          <span>结果</span>
          <select
            value={outcome}
            onChange={(event) => setOutcome(event.target.value as typeof outcome)}
          >
            <option value="ALL">全部</option>
            <option value="SUCCEEDED">成功</option>
            <option value="FAILED">失败</option>
          </select>
        </label>
        <label className="audit-search">
          <span>动作</span>
          <input
            value={action}
            onChange={(event) => setAction(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") setAppliedAction(action.trim());
            }}
            placeholder="例如 service.publish"
          />
        </label>
        <button
          className="icon-command"
          type="button"
          title="查询"
          aria-label="查询"
          onClick={() => {
            const next = action.trim();
            if (next === appliedAction) void load();
            else setAppliedAction(next);
          }}
        >
          <ReloadOutlined />
        </button>
      </div>
      <Notice error={error} />
      {loading ? <Empty icon={<LoadingOutlined spin />} text="正在读取审计事件" /> : null}
      {!loading && events.length === 0 ? (
        <Empty icon={<AuditOutlined />} text="没有匹配的审计事件" />
      ) : null}
      {!loading && events.length > 0 ? (
        <div className="operations-table audit-table">
          <div className="operations-table-head">
            <span>时间</span>
            <span>操作者</span>
            <span>动作</span>
            <span>目标</span>
            <span>结果</span>
          </div>
          {events.map((item) => (
            <div className="operations-table-row" key={item.id}>
              <time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time>
              <span>
                <b>{item.actorId}</b>
                <small>{item.actorRole}</small>
              </span>
              <code>{item.action}</code>
              <span>
                <b title={item.target}>{item.target}</b>
                <small>
                  {item.requestId} · {item.durationMs}ms
                </small>
              </span>
              <span className={`operation-status status-${item.outcome.toLowerCase()}`}>
                {item.outcome}
                <small>HTTP {item.statusCode}</small>
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
