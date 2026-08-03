import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Check,
  CircleAlert,
  Clipboard,
  KeyRound,
  ListChecks,
  LoaderCircle,
  Plus,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from "lucide-react";

import {
  McpApiError,
  type AdminRole,
  type ApiClientRecord,
  type ApiKeyRecord,
  type AuditEventRecord,
  type BuildJobSummary,
  type ClientGrantRecord,
  type McpAdminApi,
  type McpScope,
  type McpService,
} from "./api.js";

function errorMessage(error: unknown): string {
  if (error instanceof McpApiError) return error.message;
  return error instanceof Error ? error.message : "Unexpected request failure";
}

function formatDate(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function formatNameFilter(names: string[] | null): string {
  if (names === null) return "All";
  return names.length > 0 ? names.join(", ") : "None";
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <h2>{title}</h2>
          <button className="icon-button" type="button" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function Alerts({
  error,
  notice,
  clearError,
  clearNotice,
}: {
  error: string;
  notice: string;
  clearError: () => void;
  clearNotice: () => void;
}) {
  return (
    <>
      {error ? (
        <div className="alert error" role="alert">
          <CircleAlert size={17} />
          <span>{error}</span>
          <button type="button" aria-label="Dismiss error" onClick={clearError}>
            <X size={15} />
          </button>
        </div>
      ) : null}
      {notice ? (
        <div className="alert success" role="status">
          <Check size={17} />
          <span>{notice}</span>
          <button type="button" aria-label="Dismiss notice" onClick={clearNotice}>
            <X size={15} />
          </button>
        </div>
      ) : null}
    </>
  );
}

function ViewHeader({
  headingId,
  eyebrow,
  title,
  count,
  actions,
}: {
  headingId: string;
  eyebrow: string;
  title: string;
  count: string;
  actions: ReactNode;
}) {
  return (
    <header className="operational-header operational-header-row">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1 id={headingId}>{title}</h1>
        <p>{count}</p>
      </div>
      <div className="operational-actions">{actions}</div>
    </header>
  );
}

function LoadingState() {
  return (
    <div className="workspace-empty operational-empty">
      <LoaderCircle className="spin" size={28} />
    </div>
  );
}

function EmptyState({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="workspace-empty operational-empty">
      {icon}
      <h2>{title}</h2>
    </div>
  );
}

function BuildStatus({ status }: { status: BuildJobSummary["status"] }) {
  return <span className={`operation-status status-${status.toLowerCase()}`}>{status}</span>;
}

export function BuildsView({ api }: { api: McpAdminApi }) {
  const [builds, setBuilds] = useState<BuildJobSummary[]>([]);
  const [status, setStatus] = useState<"ALL" | BuildJobSummary["status"]>("ALL");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setBuilds(await api.listBuilds());
      setError("");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => void load(), [load]);

  const visible = useMemo(
    () => builds.filter((build) => status === "ALL" || build.status === status),
    [builds, status],
  );

  return (
    <section className="operational-view" aria-labelledby="builds-heading">
      <Alerts error={error} notice="" clearError={() => setError("")} clearNotice={() => {}} />
      <ViewHeader
        headingId="builds-heading"
        eyebrow="Operations"
        title="Builds"
        count={`${visible.length} of ${builds.length} jobs`}
        actions={
          <>
            <label className="compact-control">
              <span>Status</span>
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value as typeof status)}
              >
                <option value="ALL">All</option>
                <option value="QUEUED">Queued</option>
                <option value="RUNNING">Running</option>
                <option value="SUCCEEDED">Succeeded</option>
                <option value="FAILED">Failed</option>
              </select>
            </label>
            <button
              className="icon-button"
              type="button"
              aria-label="Refresh builds"
              onClick={() => void load()}
            >
              <RefreshCw size={16} />
            </button>
          </>
        }
      />
      {loading ? <LoadingState /> : null}
      {!loading && visible.length === 0 ? (
        <EmptyState icon={<ListChecks size={30} />} title="No build records" />
      ) : null}
      {!loading && visible.length > 0 ? (
        <div className="operations-table builds-table" role="table" aria-label="Build jobs">
          <div className="operations-table-header" role="row">
            <span>Service / Version</span>
            <span>Kind</span>
            <span>Stage</span>
            <span>Status</span>
            <span>Updated</span>
          </div>
          {visible.map((build) => (
            <div className="operations-table-row" role="row" key={build.id}>
              <span>
                <strong>{build.serviceName}</strong>
                <small>v{build.versionNumber}</small>
              </span>
              <code>{build.kind}</code>
              <span>
                <strong>{build.stage}</strong>
                <small>{build.errorCode ?? `Attempt ${build.attempt}`}</small>
              </span>
              <BuildStatus status={build.status} />
              <time dateTime={build.updatedAt}>{formatDate(build.updatedAt)}</time>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ClientForm({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  return (
    <form
      className="form-stack"
      onSubmit={(event) => {
        event.preventDefault();
        const normalized = name.trim();
        if (normalized) void onSubmit(normalized);
      }}
    >
      <label>
        <span>Client name</span>
        <input
          required
          maxLength={120}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <div className="form-actions">
        <button className="button secondary" type="button" onClick={onCancel}>
          Cancel
        </button>
        <button className="button primary" type="submit" disabled={busy}>
          {busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}Create client
        </button>
      </div>
    </form>
  );
}

function KeyForm({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (expiresAt: string | null) => Promise<void>;
}) {
  const [expiresAt, setExpiresAt] = useState("");
  return (
    <form
      className="form-stack"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit(expiresAt ? new Date(expiresAt).toISOString() : null);
      }}
    >
      <label>
        <span>Expires at</span>
        <input
          type="datetime-local"
          value={expiresAt}
          onChange={(event) => setExpiresAt(event.target.value)}
        />
      </label>
      <div className="form-actions">
        <button className="button secondary" type="button" onClick={onCancel}>
          Cancel
        </button>
        <button className="button primary" type="submit" disabled={busy}>
          {busy ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}Issue API Key
        </button>
      </div>
    </form>
  );
}

const scopeLabels: Array<{ value: McpScope; label: string }> = [
  { value: "mcp:connect", label: "Connect" },
  { value: "tools:list", label: "List Tools" },
  { value: "tools:call", label: "Call Tools" },
  { value: "prompts:list", label: "List Prompts" },
  { value: "prompts:get", label: "Get Prompts" },
];

function GrantForm({
  api,
  services,
  initial,
  busy,
  onCancel,
  onSubmit,
}: {
  api: McpAdminApi;
  services: McpService[];
  initial?: ClientGrantRecord;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (
    serviceId: string,
    input: { scopes: McpScope[]; toolNames: string[] | null; promptNames: string[] | null },
  ) => Promise<void>;
}) {
  const [serviceId, setServiceId] = useState(initial?.serviceId ?? services[0]?.id ?? "");
  const [scopes, setScopes] = useState<Set<McpScope>>(
    () => new Set(initial?.scopes ?? ["mcp:connect"]),
  );
  const [allTools, setAllTools] = useState(initial?.toolNames === null);
  const [allPrompts, setAllPrompts] = useState(initial?.promptNames === null);
  const [toolNames, setToolNames] = useState<Set<string>>(() => new Set(initial?.toolNames ?? []));
  const [promptNames, setPromptNames] = useState<Set<string>>(
    () => new Set(initial?.promptNames ?? []),
  );
  const [availableTools, setAvailableTools] = useState<string[]>([]);
  const [availablePrompts, setAvailablePrompts] = useState<string[]>([]);

  useEffect(() => {
    const service = services.find((item) => item.id === serviceId);
    if (!service) return;
    let active = true;
    void api.listVersions(serviceId).then((items) => {
      if (!active) return;
      const version = items.find((item) => item.id === service.currentVersionId) ?? items[0];
      setAvailableTools(version?.tools.map((tool) => tool.name) ?? []);
      setAvailablePrompts(version?.prompts.map((prompt) => prompt.name) ?? []);
    });
    return () => {
      active = false;
    };
  }, [api, serviceId, services]);

  function toggleScope(scope: McpScope) {
    setScopes((current) => {
      const next = new Set(current);
      if (next.has(scope)) {
        next.delete(scope);
        if (scope === "tools:list") next.delete("tools:call");
        if (scope === "prompts:list") next.delete("prompts:get");
      } else {
        next.add(scope);
        if (scope === "tools:call") next.add("tools:list");
        if (scope === "prompts:get") next.add("prompts:list");
      }
      next.add("mcp:connect");
      return next;
    });
  }

  const tools = [...new Set([...availableTools, ...toolNames])];
  const prompts = [...new Set([...availablePrompts, ...promptNames])];

  return (
    <form
      className="form-stack"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit(serviceId, {
          scopes: scopeLabels.map((item) => item.value).filter((scope) => scopes.has(scope)),
          toolNames: allTools ? null : [...toolNames],
          promptNames: allPrompts ? null : [...promptNames],
        });
      }}
    >
      <label>
        <span>Service</span>
        <select
          required
          disabled={Boolean(initial)}
          value={serviceId}
          onChange={(event) => setServiceId(event.target.value)}
        >
          {services.map((service) => (
            <option key={service.id} value={service.id}>
              {service.name}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="option-fieldset">
        <legend>Scopes</legend>
        <div className="checkbox-grid">
          {scopeLabels.map((scope) => (
            <label key={scope.value}>
              <input
                type="checkbox"
                checked={scopes.has(scope.value)}
                disabled={scope.value === "mcp:connect"}
                onChange={() => toggleScope(scope.value)}
              />
              <span>{scope.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {scopes.has("tools:list") || scopes.has("tools:call") ? (
        <fieldset className="option-fieldset">
          <legend>Tools</legend>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={allTools}
              onChange={(event) => setAllTools(event.target.checked)}
            />
            <span>All Tools</span>
          </label>
          {!allTools ? (
            <div className="checkbox-grid capability-options">
              {tools.map((name) => (
                <label key={name}>
                  <input
                    type="checkbox"
                    checked={toolNames.has(name)}
                    onChange={() =>
                      setToolNames((current) => {
                        const next = new Set(current);
                        if (next.has(name)) next.delete(name);
                        else next.add(name);
                        return next;
                      })
                    }
                  />
                  <code>{name}</code>
                </label>
              ))}
            </div>
          ) : null}
        </fieldset>
      ) : null}
      {scopes.has("prompts:list") || scopes.has("prompts:get") ? (
        <fieldset className="option-fieldset">
          <legend>Prompts</legend>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={allPrompts}
              onChange={(event) => setAllPrompts(event.target.checked)}
            />
            <span>All Prompts</span>
          </label>
          {!allPrompts ? (
            <div className="checkbox-grid capability-options">
              {prompts.map((name) => (
                <label key={name}>
                  <input
                    type="checkbox"
                    checked={promptNames.has(name)}
                    onChange={() =>
                      setPromptNames((current) => {
                        const next = new Set(current);
                        if (next.has(name)) next.delete(name);
                        else next.add(name);
                        return next;
                      })
                    }
                  />
                  <code>{name}</code>
                </label>
              ))}
            </div>
          ) : null}
        </fieldset>
      ) : null}
      <div className="form-actions">
        <button className="button secondary" type="button" onClick={onCancel}>
          Cancel
        </button>
        <button className="button primary" type="submit" disabled={busy || !serviceId}>
          {busy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}Save grant
        </button>
      </div>
    </form>
  );
}

export function ClientsView({
  api,
  services,
  role,
}: {
  api: McpAdminApi;
  services: McpService[];
  role: AdminRole;
}) {
  const [clients, setClients] = useState<ApiClientRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [grants, setGrants] = useState<ClientGrantRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [clientDialog, setClientDialog] = useState(false);
  const [keyDialog, setKeyDialog] = useState(false);
  const [grantDialog, setGrantDialog] = useState<ClientGrantRecord | "new" | null>(null);
  const [rawKey, setRawKey] = useState<string | null>(null);

  const loadClients = useCallback(async () => {
    if (role === "operator") {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const items = await api.listClients();
      setClients(items);
      setSelectedId((current) => current ?? items[0]?.id ?? null);
      setError("");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [api, role]);

  const loadAccess = useCallback(
    async (clientId: string) => {
      try {
        const [nextKeys, nextGrants] = await Promise.all([
          api.listApiKeys(clientId),
          api.listGrants(clientId),
        ]);
        setKeys(nextKeys);
        setGrants(nextGrants);
        setError("");
      } catch (cause) {
        setError(errorMessage(cause));
      }
    },
    [api],
  );

  useEffect(() => void loadClients(), [loadClients]);
  useEffect(() => {
    if (selectedId) void loadAccess(selectedId);
    else {
      setKeys([]);
      setGrants([]);
    }
  }, [loadAccess, selectedId]);

  async function perform(action: () => Promise<void>, success: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      setNotice(success);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const client = clients.find((item) => item.id === selectedId) ?? null;

  if (role === "operator") {
    return (
      <section className="operational-view" aria-labelledby="clients-heading">
        <ViewHeader
          headingId="clients-heading"
          eyebrow="Access control"
          title="Clients"
          count="Restricted view"
          actions={null}
        />
        <EmptyState icon={<ShieldCheck size={30} />} title="Admin or auditor access required" />
      </section>
    );
  }

  return (
    <section className="operational-view" aria-labelledby="clients-heading">
      <Alerts
        error={error}
        notice={notice}
        clearError={() => setError("")}
        clearNotice={() => setNotice("")}
      />
      <ViewHeader
        headingId="clients-heading"
        eyebrow="Access control"
        title="Clients"
        count={`${clients.length} registered`}
        actions={
          <>
            <button
              className="icon-button"
              type="button"
              aria-label="Refresh clients"
              onClick={() => void loadClients()}
            >
              <RefreshCw size={16} />
            </button>
            {role === "admin" ? (
              <button
                className="button primary"
                type="button"
                onClick={() => setClientDialog(true)}
              >
                <Plus size={16} />
                New client
              </button>
            ) : null}
          </>
        }
      />
      {loading ? <LoadingState /> : null}
      {!loading && clients.length === 0 ? (
        <EmptyState icon={<Users size={30} />} title="No clients" />
      ) : null}
      {!loading && clients.length > 0 ? (
        <div className="client-workspace">
          <div className="client-list" aria-label="API clients">
            {clients.map((item) => (
              <button
                key={item.id}
                type="button"
                className={item.id === selectedId ? "active" : ""}
                onClick={() => setSelectedId(item.id)}
              >
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.status}</small>
                </span>
                <code>{item.id.slice(0, 8)}</code>
              </button>
            ))}
          </div>
          {client ? (
            <div className="client-detail">
              <section className="detail-section">
                <div className="section-heading compact-heading">
                  <div>
                    <h2>API Keys</h2>
                    <p>{keys.filter((key) => key.status === "ACTIVE").length} active</p>
                  </div>
                  {role === "admin" ? (
                    <button
                      className="button secondary"
                      type="button"
                      onClick={() => setKeyDialog(true)}
                    >
                      <KeyRound size={15} />
                      Issue key
                    </button>
                  ) : null}
                </div>
                <div className="operations-table keys-table" role="table" aria-label="API Keys">
                  <div className="operations-table-header" role="row">
                    <span>Key</span>
                    <span>Status</span>
                    <span>Last used</span>
                    <span>Expires</span>
                    <span />
                  </div>
                  {keys.map((key) => (
                    <div className="operations-table-row" role="row" key={key.id}>
                      <code>{key.id.slice(0, 12)}</code>
                      <span className={`operation-status status-${key.status.toLowerCase()}`}>
                        {key.status}
                      </span>
                      <time>{formatDate(key.lastUsedAt)}</time>
                      <time>{formatDate(key.expiresAt)}</time>
                      {role === "admin" && key.status === "ACTIVE" ? (
                        <button
                          className="icon-button danger"
                          type="button"
                          aria-label={`Revoke key ${key.id}`}
                          onClick={() => {
                            if (!confirm("Revoke this API Key?")) return;
                            void perform(async () => {
                              await api.revokeApiKey(client.id, key.id);
                              await loadAccess(client.id);
                            }, "API Key revoked");
                          }}
                        >
                          <Trash2 size={15} />
                        </button>
                      ) : (
                        <span />
                      )}
                    </div>
                  ))}
                  {keys.length === 0 ? <div className="inline-empty">No API Keys</div> : null}
                </div>
              </section>
              <section className="detail-section">
                <div className="section-heading compact-heading">
                  <div>
                    <h2>Service Grants</h2>
                    <p>{grants.length} configured</p>
                  </div>
                  {role === "admin" ? (
                    <button
                      className="button secondary"
                      type="button"
                      onClick={() => setGrantDialog("new")}
                    >
                      <Plus size={15} />
                      Add grant
                    </button>
                  ) : null}
                </div>
                <div className="grant-list">
                  {grants.map((grant) => {
                    const service = services.find((item) => item.id === grant.serviceId);
                    return (
                      <article className="grant-row" key={grant.id}>
                        <div>
                          <strong>{service?.name ?? grant.serviceId}</strong>
                          <small>{grant.scopes.join(" · ")}</small>
                        </div>
                        <div className="grant-filters">
                          <span>Tools: {formatNameFilter(grant.toolNames)}</span>
                          <span>Prompts: {formatNameFilter(grant.promptNames)}</span>
                        </div>
                        {role === "admin" ? (
                          <span className="row-actions">
                            <button
                              className="text-button"
                              type="button"
                              onClick={() => setGrantDialog(grant)}
                            >
                              Edit
                            </button>
                            <button
                              className="icon-button danger"
                              type="button"
                              aria-label={`Delete grant ${service?.name ?? grant.serviceId}`}
                              onClick={() => {
                                if (!confirm("Delete this service grant?")) return;
                                void perform(async () => {
                                  await api.deleteGrant(client.id, grant.serviceId);
                                  await loadAccess(client.id);
                                }, "Grant deleted");
                              }}
                            >
                              <Trash2 size={15} />
                            </button>
                          </span>
                        ) : null}
                      </article>
                    );
                  })}
                  {grants.length === 0 ? (
                    <div className="inline-empty">No service grants</div>
                  ) : null}
                </div>
              </section>
            </div>
          ) : null}
        </div>
      ) : null}

      {clientDialog ? (
        <Modal title="New API client" onClose={() => setClientDialog(false)}>
          <ClientForm
            busy={busy}
            onCancel={() => setClientDialog(false)}
            onSubmit={async (name) =>
              perform(async () => {
                const created = await api.createClient(name);
                setClients((items) => [created, ...items]);
                setSelectedId(created.id);
                setClientDialog(false);
              }, "Client created")
            }
          />
        </Modal>
      ) : null}

      {keyDialog && client ? (
        <Modal title="Issue API Key" onClose={() => setKeyDialog(false)}>
          <KeyForm
            busy={busy}
            onCancel={() => setKeyDialog(false)}
            onSubmit={async (expiresAt) =>
              perform(async () => {
                const issued = await api.createApiKey(client.id, expiresAt);
                setRawKey(issued.rawKey);
                setKeyDialog(false);
                await loadAccess(client.id);
              }, "API Key issued")
            }
          />
        </Modal>
      ) : null}

      {rawKey ? (
        <Modal title="API Key created" onClose={() => setRawKey(null)}>
          <div className="form-stack">
            <div className="secret-key">
              <code>{rawKey}</code>
              <button
                className="icon-button"
                type="button"
                aria-label="Copy API Key"
                onClick={() => void navigator.clipboard.writeText(rawKey)}
              >
                <Clipboard size={16} />
              </button>
            </div>
            <div className="form-actions">
              <button className="button primary" type="button" onClick={() => setRawKey(null)}>
                Done
              </button>
            </div>
          </div>
        </Modal>
      ) : null}

      {grantDialog && client ? (
        <Modal
          title={grantDialog === "new" ? "Add service grant" : "Edit service grant"}
          onClose={() => setGrantDialog(null)}
        >
          <GrantForm
            api={api}
            services={services}
            initial={grantDialog === "new" ? undefined : grantDialog}
            busy={busy}
            onCancel={() => setGrantDialog(null)}
            onSubmit={async (serviceId, input) =>
              perform(async () => {
                await api.upsertGrant(client.id, serviceId, input);
                setGrantDialog(null);
                await loadAccess(client.id);
              }, "Grant saved")
            }
          />
        </Modal>
      ) : null}
    </section>
  );
}

export function AuditView({ api, role }: { api: McpAdminApi; role: AdminRole }) {
  const [events, setEvents] = useState<AuditEventRecord[]>([]);
  const [outcome, setOutcome] = useState<"ALL" | AuditEventRecord["outcome"]>("ALL");
  const [actionInput, setActionInput] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (role === "operator") {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setEvents(
        await api.listAuditEvents({
          ...(outcome === "ALL" ? {} : { outcome }),
          ...(actionFilter ? { action: actionFilter } : {}),
        }),
      );
      setError("");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [actionFilter, api, outcome, role]);

  useEffect(() => void load(), [load]);

  if (role === "operator") {
    return (
      <section className="operational-view" aria-labelledby="audit-heading">
        <ViewHeader
          headingId="audit-heading"
          eyebrow="Governance"
          title="Audit"
          count="Restricted view"
          actions={null}
        />
        <EmptyState icon={<ShieldCheck size={30} />} title="Admin or auditor access required" />
      </section>
    );
  }

  return (
    <section className="operational-view" aria-labelledby="audit-heading">
      <Alerts error={error} notice="" clearError={() => setError("")} clearNotice={() => {}} />
      <ViewHeader
        headingId="audit-heading"
        eyebrow="Governance"
        title="Audit"
        count={`${events.length} recent events`}
        actions={
          <>
            <label className="compact-control">
              <span>Outcome</span>
              <select
                value={outcome}
                onChange={(event) => setOutcome(event.target.value as typeof outcome)}
              >
                <option value="ALL">All</option>
                <option value="SUCCEEDED">Succeeded</option>
                <option value="FAILED">Failed</option>
              </select>
            </label>
            <label className="compact-control">
              <span>Action</span>
              <input
                value={actionInput}
                onChange={(event) => setActionInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") setActionFilter(actionInput.trim());
                }}
              />
            </label>
            <button
              className="icon-button"
              type="button"
              aria-label="Refresh audit events"
              onClick={() => {
                const nextFilter = actionInput.trim();
                if (nextFilter === actionFilter) void load();
                else setActionFilter(nextFilter);
              }}
            >
              <RefreshCw size={16} />
            </button>
          </>
        }
      />
      {loading ? <LoadingState /> : null}
      {!loading && events.length === 0 ? (
        <EmptyState icon={<ScrollText size={30} />} title="No audit events" />
      ) : null}
      {!loading && events.length > 0 ? (
        <div className="operations-table audit-table" role="table" aria-label="Audit events">
          <div className="operations-table-header" role="row">
            <span>Time</span>
            <span>Actor</span>
            <span>Action</span>
            <span>Target</span>
            <span>Outcome</span>
          </div>
          {events.map((event) => (
            <div className="operations-table-row" role="row" key={event.id}>
              <time dateTime={event.createdAt}>{formatDate(event.createdAt)}</time>
              <span>
                <strong>{event.actorId}</strong>
                <small>{event.actorRole}</small>
              </span>
              <code>{event.action}</code>
              <span>
                <strong className="truncate">{event.target}</strong>
                <small>
                  {event.requestId} · {event.durationMs}ms
                </small>
              </span>
              <span className={`operation-status status-${event.outcome.toLowerCase()}`}>
                {event.outcome}
                <small>HTTP {event.statusCode}</small>
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
