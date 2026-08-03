import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { PromptDefinitionSchema } from "@open-agent-tools/mcp-contracts";
import {
  Archive,
  Blocks,
  Box,
  Check,
  ChevronRight,
  CircleAlert,
  Code2,
  FileCode2,
  GitBranch,
  ListChecks,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  Rocket,
  ScrollText,
  Server,
  ShieldCheck,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-react";

import {
  McpApiClient,
  McpApiError,
  type AdminRole,
  type McpAdminApi,
  type McpPrompt,
  type McpService,
  type McpTool,
  type McpVersion,
  type PromptMessage,
} from "./api.js";
import { AuditView, BuildsView, ClientsView } from "./operations.js";
import "./styles.css";

type WorkspaceTab = "tools" | "prompts" | "versions";
type PrimaryView = "services" | "builds" | "clients" | "audit";
type DialogState =
  | { kind: "create-service" }
  | { kind: "edit-service" }
  | { kind: "tool"; value?: McpTool & { id: string } }
  | { kind: "prompt"; value?: McpPrompt & { id: string } }
  | { kind: "preview-prompt"; value: McpPrompt & { id: string } }
  | null;

const defaultApi = new McpApiClient();
const SERVICE_SLUG_PATTERN = /^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function promptIssueMessage(issue: { path: PropertyKey[]; message: string }): string {
  if (/^messages\.\d+\.content\.text$/.test(issue.path.join("."))) {
    return "Prompt message text cannot be empty.";
  }
  return issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
}

const statusLabels: Record<McpVersion["status"], string> = {
  DRAFT: "Draft",
  VALIDATING: "Inspecting",
  BUILDING: "Building",
  READY: "Ready",
  FAILED: "Failed",
  PUBLISHED: "Published",
  SUPERSEDED: "Superseded",
};

function messageFrom(error: unknown): string {
  if (error instanceof McpApiError) {
    if (error.code === "CONFLICT") return "This draft changed elsewhere. Refresh before retrying.";
    return error.message;
  }
  return error instanceof Error ? error.message : "Unexpected request failure";
}

function StatusBadge({ status }: { status: McpVersion["status"] }) {
  return <span className={`status status-${status.toLowerCase()}`}>{statusLabels[status]}</span>;
}

function IconButton({
  label,
  onClick,
  children,
  danger = false,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      className={`icon-button${danger ? " danger" : ""}`}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
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
          <IconButton label="Close" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </header>
        {children}
      </section>
    </div>
  );
}

function ServiceForm({
  initial,
  busy,
  onCancel,
  onSubmit,
}: {
  initial?: McpService;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (value: { name: string; slug: string }) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [slug, setSlug] = useState(initial?.slug ?? "");
  const [formError, setFormError] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = { name: name.trim(), slug: slug.trim() };
    if (!normalized.name) {
      setFormError("Service name is required.");
      return;
    }
    if (!SERVICE_SLUG_PATTERN.test(normalized.slug)) {
      setFormError(
        "Slug must start with a lowercase letter, use only lowercase letters, numbers, or hyphens, and end with a letter or number.",
      );
      return;
    }
    setFormError("");
    void onSubmit(normalized);
  }

  return (
    <form className="form-stack" noValidate onSubmit={submit}>
      <label>
        <span>Service name</span>
        <input
          required
          maxLength={120}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label>
        <span>Slug</span>
        <input
          required
          pattern="[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?"
          maxLength={64}
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
        />
      </label>
      {formError ? (
        <p className="field-error" role="alert">
          {formError}
        </p>
      ) : null}
      <div className="form-actions">
        <button type="button" className="button secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="button primary" disabled={busy}>
          {busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
          Save service
        </button>
      </div>
    </form>
  );
}

function ToolForm({
  initial,
  busy,
  onCancel,
  onSubmit,
}: {
  initial?: McpTool;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (value: McpTool) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [handler, setHandler] = useState(initial?.handler ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [schema, setSchema] = useState(
    JSON.stringify(
      initial?.inputSchema ?? { type: "object", properties: {}, additionalProperties: false },
      null,
      2,
    ),
  );
  const [schemaError, setSchemaError] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    try {
      const inputSchema = JSON.parse(schema) as Record<string, unknown>;
      setSchemaError("");
      void onSubmit({ name, handler, ...(description ? { description } : {}), inputSchema });
    } catch {
      setSchemaError("Input schema must be valid JSON.");
    }
  }

  return (
    <form className="form-stack" onSubmit={submit}>
      <div className="form-grid">
        <label>
          <span>Tool name</span>
          <input required value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          <span>Handler export</span>
          <input required value={handler} onChange={(event) => setHandler(event.target.value)} />
        </label>
      </div>
      <label>
        <span>Description</span>
        <input value={description} onChange={(event) => setDescription(event.target.value)} />
      </label>
      <label>
        <span>Input JSON Schema</span>
        <textarea
          className="code-field"
          rows={12}
          value={schema}
          onChange={(event) => setSchema(event.target.value)}
        />
      </label>
      {schemaError ? <p className="field-error">{schemaError}</p> : null}
      <div className="form-actions">
        <button type="button" className="button secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="button primary" disabled={busy}>
          {busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
          Save Tool
        </button>
      </div>
    </form>
  );
}

function PromptForm({
  initial,
  busy,
  onCancel,
  onSubmit,
}: {
  initial?: McpPrompt;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (value: McpPrompt) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [argumentsJson, setArgumentsJson] = useState(
    JSON.stringify(initial?.arguments ?? [], null, 2),
  );
  const [messagesJson, setMessagesJson] = useState(
    JSON.stringify(
      initial?.messages ?? [{ role: "user", content: { type: "text", text: "" } }],
      null,
      2,
    ),
  );
  const [jsonError, setJsonError] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    try {
      const argumentsValue = JSON.parse(argumentsJson) as McpPrompt["arguments"];
      const messages = JSON.parse(messagesJson) as PromptMessage[];
      const result = PromptDefinitionSchema.safeParse({
        name: name.trim(),
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        arguments: argumentsValue,
        messages,
      });
      if (!result.success) {
        setJsonError(promptIssueMessage(result.error.issues[0]!));
        return;
      }
      setJsonError("");
      void onSubmit(result.data);
    } catch {
      setJsonError("Arguments and messages must be valid JSON.");
    }
  }

  return (
    <form className="form-stack" onSubmit={submit}>
      <div className="form-grid">
        <label>
          <span>Prompt name</span>
          <input required value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          <span>Title</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
      </div>
      <label>
        <span>Description</span>
        <input value={description} onChange={(event) => setDescription(event.target.value)} />
      </label>
      <label>
        <span>Arguments</span>
        <textarea
          className="code-field"
          rows={7}
          value={argumentsJson}
          onChange={(event) => setArgumentsJson(event.target.value)}
        />
      </label>
      <label>
        <span>Messages</span>
        <textarea
          className="code-field"
          rows={11}
          value={messagesJson}
          onChange={(event) => setMessagesJson(event.target.value)}
        />
      </label>
      {jsonError ? (
        <p className="field-error" role="alert">
          {jsonError}
        </p>
      ) : null}
      <div className="form-actions">
        <button type="button" className="button secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="button primary" disabled={busy}>
          {busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
          Save Prompt
        </button>
      </div>
    </form>
  );
}

function PromptPreviewForm({
  prompt,
  busy,
  messages,
  error,
  onCancel,
  onSubmit,
}: {
  prompt: McpPrompt;
  busy: boolean;
  messages: PromptMessage[] | null;
  error: string;
  onCancel: () => void;
  onSubmit: (argumentsByName: Record<string, string>) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(prompt.arguments.map((argument) => [argument.name, ""])),
  );

  return (
    <form
      className="form-stack preview-form"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit(values);
      }}
    >
      {prompt.arguments.length > 0 ? (
        <div className="prompt-arguments">
          {prompt.arguments.map((argument) => (
            <label key={argument.name}>
              <span>
                {argument.name}
                {argument.required ? <strong aria-hidden="true">Required</strong> : null}
              </span>
              <input
                aria-label={argument.name}
                required={argument.required}
                value={values[argument.name] ?? ""}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [argument.name]: event.target.value }))
                }
              />
              {argument.description ? <small>{argument.description}</small> : null}
            </label>
          ))}
        </div>
      ) : null}

      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}

      {messages ? (
        <section className="prompt-preview-output" aria-live="polite">
          <h3>Rendered messages</h3>
          {messages.map((message, index) => (
            <div className="rendered-message" key={`${message.role}-${index}`}>
              <span>{message.role}</span>
              <pre>{message.content.text}</pre>
            </div>
          ))}
        </section>
      ) : null}

      <div className="form-actions">
        <button type="button" className="button secondary" onClick={onCancel}>
          Close
        </button>
        <button type="submit" className="button primary" disabled={busy}>
          {busy ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}
          Render preview
        </button>
      </div>
    </form>
  );
}

export function App({ api = defaultApi, role = "admin" }: { api?: McpAdminApi; role?: AdminRole }) {
  const [primaryView, setPrimaryView] = useState<PrimaryView>("services");
  const [services, setServices] = useState<McpService[]>([]);
  const [service, setService] = useState<McpService | null>(null);
  const [versions, setVersions] = useState<McpVersion[]>([]);
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [tab, setTab] = useState<WorkspaceTab>("tools");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [previewMessages, setPreviewMessages] = useState<PromptMessage[] | null>(null);
  const [previewError, setPreviewError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const version = useMemo(
    () => versions.find((item) => item.id === selectedVersionId) ?? versions[0] ?? null,
    [selectedVersionId, versions],
  );
  const editable = role !== "auditor" && version?.status === "DRAFT";
  const packageRetryable =
    version?.status === "DRAFT" ||
    version?.status === "FAILED" ||
    version?.status === "VALIDATING" ||
    version?.status === "BUILDING";

  const loadServices = useCallback(async () => {
    setLoading(true);
    try {
      const items = await api.listServices();
      setServices(items);
      setSelectedServiceId((current) => current ?? items[0]?.id ?? null);
      setError("");
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setLoading(false);
    }
  }, [api]);

  const loadService = useCallback(
    async (serviceId: string) => {
      try {
        const [nextService, nextVersions] = await Promise.all([
          api.getService(serviceId),
          api.listVersions(serviceId),
        ]);
        setService(nextService);
        setVersions(nextVersions);
        const selected =
          nextVersions.find((item) => item.status === "DRAFT") ??
          nextVersions.find((item) => item.id === nextService.currentVersionId) ??
          nextVersions[0] ??
          null;
        setSelectedVersionId(selected?.id ?? null);
        setTab(selected && selected.tools.length === 0 ? "prompts" : "tools");
        setError("");
      } catch (cause) {
        setError(messageFrom(cause));
      }
    },
    [api],
  );

  useEffect(() => {
    void loadServices();
  }, [loadServices]);

  useEffect(() => {
    if (selectedServiceId) void loadService(selectedServiceId);
    else {
      setService(null);
      setVersions([]);
    }
  }, [loadService, selectedServiceId]);

  async function perform(action: () => Promise<void>, success?: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      if (success) setNotice(success);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setBusy(false);
    }
  }

  async function replaceVersion(next: McpVersion) {
    setVersions((items) => items.map((item) => (item.id === next.id ? next : item)));
    setSelectedVersionId(next.id);
  }

  const serviceTools = version?.tools ?? [];
  const servicePrompts = version?.prompts ?? [];

  return (
    <div className={`app-shell${primaryView === "services" ? "" : " operational-layout"}`}>
      <aside className="rail">
        <div className="brand-mark">
          <Blocks size={20} />
          <span>MCP Registry</span>
        </div>
        <nav aria-label="Primary navigation">
          <button
            className={`rail-link${primaryView === "services" ? " active" : ""}`}
            type="button"
            aria-label="Services"
            aria-current={primaryView === "services" ? "page" : undefined}
            title="Services"
            onClick={() => setPrimaryView("services")}
          >
            <Server size={18} />
            <span>Services</span>
          </button>
          <button
            className={`rail-link${primaryView === "builds" ? " active" : ""}`}
            type="button"
            aria-label="Builds"
            aria-current={primaryView === "builds" ? "page" : undefined}
            title="Builds"
            onClick={() => setPrimaryView("builds")}
          >
            <ListChecks size={18} />
            <span>Builds</span>
          </button>
          <button
            className={`rail-link${primaryView === "clients" ? " active" : ""}`}
            type="button"
            aria-label="Clients"
            aria-current={primaryView === "clients" ? "page" : undefined}
            title="Clients"
            onClick={() => setPrimaryView("clients")}
          >
            <Users size={18} />
            <span>Clients</span>
          </button>
          <button
            className={`rail-link${primaryView === "audit" ? " active" : ""}`}
            type="button"
            aria-label="Audit"
            aria-current={primaryView === "audit" ? "page" : undefined}
            title="Audit"
            onClick={() => setPrimaryView("audit")}
          >
            <ScrollText size={18} />
            <span>Audit</span>
          </button>
        </nav>
        <div className="rail-footer">
          <span className="environment-dot" />
          Production
          <small>{role}</small>
        </div>
      </aside>

      {primaryView === "services" ? (
        <aside className="service-pane">
          <header className="pane-header">
            <div>
              <span className="eyebrow">Catalog</span>
              <h2>Services</h2>
            </div>
            {role !== "auditor" ? (
              <button
                className="button primary compact"
                type="button"
                onClick={() => setDialog({ kind: "create-service" })}
              >
                <Plus size={16} />
                New service
              </button>
            ) : null}
          </header>
          <div className="service-search-row">
            <span>{services.length} registered</span>
            <IconButton label="Refresh services" onClick={() => void loadServices()}>
              <RefreshCw size={16} />
            </IconButton>
          </div>
          <div className="service-list" aria-label="MCP services">
            {loading ? (
              <div className="center-state">
                <LoaderCircle className="spin" size={20} />
              </div>
            ) : null}
            {!loading && services.length === 0 ? (
              <div className="empty-state">
                <Box size={24} />
                <p>No services</p>
              </div>
            ) : null}
            {services.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`service-row${selectedServiceId === item.id ? " active" : ""}`}
                onClick={() => setSelectedServiceId(item.id)}
              >
                <span className="service-glyph">
                  <Code2 size={17} />
                </span>
                <span className="service-row-copy">
                  <strong>{item.name}</strong>
                  <small>/{item.slug}</small>
                </span>
                <span className={`service-state service-${item.status.toLowerCase()}`} />
                <ChevronRight size={15} />
              </button>
            ))}
          </div>
        </aside>
      ) : null}

      <main className="workspace">
        {primaryView === "services" ? (
          <>
            {error ? (
              <div className="alert error">
                <CircleAlert size={17} />
                <span>{error}</span>
                <button onClick={() => setError("")}>
                  <X size={15} />
                </button>
              </div>
            ) : null}
            {notice ? (
              <div className="alert success">
                <Check size={17} />
                <span>{notice}</span>
                <button onClick={() => setNotice("")}>
                  <X size={15} />
                </button>
              </div>
            ) : null}
            {!service || !version ? (
              <div className="workspace-empty">
                <Archive size={34} />
                <h1>Select a service</h1>
              </div>
            ) : (
              <>
                <header className="workspace-header">
                  <div className="title-lockup">
                    <span className="service-icon">
                      <FileCode2 size={24} />
                    </span>
                    <div>
                      <div className="title-line">
                        <h1>{service.name}</h1>
                        <StatusBadge status={version.status} />
                      </div>
                      <p>
                        /{service.slug} <span>·</span> Managed MCP <span>·</span> v
                        {version.versionNumber}
                      </p>
                    </div>
                  </div>
                  <div className="header-actions">
                    {role !== "auditor" ? (
                      <IconButton
                        label="Edit service"
                        onClick={() => setDialog({ kind: "edit-service" })}
                      >
                        <Pencil size={17} />
                      </IconButton>
                    ) : null}
                    {role === "admin" && service.status === "ACTIVE" ? (
                      <IconButton
                        label="Disable service"
                        danger
                        onClick={() => {
                          if (!confirm(`Disable ${service.name}?`)) return;
                          void perform(async () => {
                            const disabled = await api.disableService(service.id, service.revision);
                            setService(disabled);
                            setServices((items) =>
                              items.map((item) => (item.id === disabled.id ? disabled : item)),
                            );
                          }, "Service disabled");
                        }}
                      >
                        <Power size={17} />
                      </IconButton>
                    ) : null}
                    {role === "admin" && service.status === "DISABLED" ? (
                      <IconButton
                        label="Enable service"
                        onClick={() => {
                          if (!confirm(`Enable ${service.name}?`)) return;
                          void perform(async () => {
                            const enabled = await api.enableService(service.id, service.revision);
                            setService(enabled);
                            setServices((items) =>
                              items.map((item) => (item.id === enabled.id ? enabled : item)),
                            );
                          }, "Service enabled");
                        }}
                      >
                        <Power size={17} />
                      </IconButton>
                    ) : null}
                    {role === "admin" ? (
                      <IconButton
                        label="Delete service"
                        danger
                        onClick={() => {
                          if (!confirm(`Delete ${service.name}?`)) return;
                          void perform(async () => {
                            await api.deleteService(service.id, service.revision);
                            setSelectedServiceId(null);
                            await loadServices();
                          }, "Service deleted");
                        }}
                      >
                        <Trash2 size={17} />
                      </IconButton>
                    ) : null}
                  </div>
                </header>

                <section className="version-strip" aria-label="Version lifecycle">
                  <div className="version-meta">
                    <span>Revision {version.revision}</span>
                    <strong>{version.tools.length} Tools</strong>
                    <strong>{version.prompts.length} Prompts</strong>
                  </div>
                  <div className="lifecycle-actions">
                    {role !== "auditor" && version.tools.length > 0 ? (
                      <>
                        <input
                          ref={fileInput}
                          className="visually-hidden"
                          type="file"
                          accept=".zip,application/zip"
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (!file) return;
                            event.target.value = "";
                            void perform(async () => {
                              const result = await api.uploadArtifact(
                                service.id,
                                version.id,
                                version.revision,
                                file,
                              );
                              await replaceVersion(result.version);
                            }, "Package queued for inspection");
                          }}
                        />
                        <button
                          className="button secondary"
                          type="button"
                          onClick={() => fileInput.current?.click()}
                          disabled={busy || !packageRetryable}
                        >
                          <Upload size={16} />
                          Upload package
                        </button>
                        <button
                          className="button secondary"
                          type="button"
                          disabled={busy || !packageRetryable || !version.artifactDigest}
                          onClick={() =>
                            void perform(async () => {
                              const result = await api.buildVersion(
                                service.id,
                                version.id,
                                version.revision,
                              );
                              await replaceVersion(result.version);
                            }, "Build queued")
                          }
                        >
                          <Play size={16} />
                          Build version
                        </button>
                      </>
                    ) : null}
                    {role !== "auditor" &&
                    version.tools.length === 0 &&
                    version.status === "DRAFT" ? (
                      <button
                        className="button secondary"
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void perform(async () => {
                            await replaceVersion(
                              await api.validateVersion(service.id, version.id, version.revision),
                            );
                          }, "Prompt version validated")
                        }
                      >
                        <ShieldCheck size={16} />
                        Validate
                      </button>
                    ) : null}
                    {role === "admin" && version.status === "READY" ? (
                      <button
                        className="button primary"
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void perform(async () => {
                            const published = await api.publishVersion(
                              service.id,
                              version.id,
                              version.revision,
                            );
                            setService(published.service);
                            await replaceVersion(published.version);
                          }, "Version published")
                        }
                      >
                        <Rocket size={16} />
                        Publish
                      </button>
                    ) : null}
                    {role !== "auditor" && version.status === "READY" ? (
                      <button
                        className="button secondary"
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          if (
                            !confirm(
                              "Reset this version back to draft? Its image digest will be cleared.",
                            )
                          ) {
                            return;
                          }
                          void perform(async () => {
                            await replaceVersion(
                              await api.resetVersionToDraft(
                                service.id,
                                version.id,
                                version.revision,
                              ),
                            );
                          }, "Version reset to draft");
                        }}
                      >
                        <RotateCcw size={16} />
                        Reset to draft
                      </button>
                    ) : null}
                    {role !== "auditor" &&
                    (version.status === "PUBLISHED" || version.status === "SUPERSEDED") ? (
                      <button
                        className="button secondary"
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          if (
                            !confirm(
                              "Fork a new draft version from this version? Tools and prompts will be copied.",
                            )
                          ) {
                            return;
                          }
                          void perform(async () => {
                            const fork = await api.forkDraftVersion(service.id, version.id);
                            setVersions((items) => [...items, fork]);
                            setSelectedVersionId(fork.id);
                            setTab(fork.tools.length === 0 ? "prompts" : "tools");
                          }, "New draft version forked");
                        }}
                      >
                        <GitBranch size={16} />
                        Fork new draft
                      </button>
                    ) : null}
                    {role === "admin" &&
                    service.status === "ACTIVE" &&
                    service.currentVersionId !== version.id &&
                    (version.status === "READY" || version.status === "SUPERSEDED") ? (
                      <button
                        className="button secondary"
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          if (!confirm(`Roll back ${service.name} to v${version.versionNumber}?`))
                            return;
                          void perform(async () => {
                            const rolledBack = await api.rollbackVersion(
                              service.id,
                              version.id,
                              version.revision,
                            );
                            setService(rolledBack.service);
                            await loadService(service.id);
                          }, `Rolled back to v${version.versionNumber}`);
                        }}
                      >
                        <RotateCcw size={16} />
                        Roll back version
                      </button>
                    ) : null}
                  </div>
                </section>

                <div className="tabs" role="tablist" aria-label="Service configuration">
                  {(["tools", "prompts", "versions"] as const).map((item) => (
                    <button
                      key={item}
                      type="button"
                      role="tab"
                      aria-selected={tab === item}
                      className={tab === item ? "active" : ""}
                      onClick={() => setTab(item)}
                    >
                      {item === "tools" ? "Tools" : item === "prompts" ? "Prompts" : "Versions"}
                      {item !== "versions" ? (
                        <span>
                          {item === "tools" ? serviceTools.length : servicePrompts.length}
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>

                <section className="tab-content">
                  {tab === "tools" ? (
                    <>
                      <div className="section-heading">
                        <div>
                          <h2>Tools</h2>
                          <p>Runtime handlers exposed through MCP.</p>
                        </div>
                        {editable ? (
                          <button
                            className="button secondary"
                            type="button"
                            onClick={() => setDialog({ kind: "tool" })}
                          >
                            <Plus size={16} />
                            Add Tool
                          </button>
                        ) : null}
                      </div>
                      <div className="capability-table" role="table" aria-label="Configured Tools">
                        <div className="table-header" role="row">
                          <span>Name</span>
                          <span>Handler</span>
                          <span>Input</span>
                          <span />
                        </div>
                        {serviceTools.map((tool) => (
                          <div className="table-row" role="row" key={tool.id}>
                            <span>
                              <Code2 size={16} />
                              <strong>{tool.name}</strong>
                              <small>{tool.description ?? "No description"}</small>
                            </span>
                            <code>{tool.handler}</code>
                            <span className="schema-summary">
                              {
                                Object.keys(
                                  (tool.inputSchema.properties as object | undefined) ?? {},
                                ).length
                              }{" "}
                              fields
                            </span>
                            <span className="row-actions">
                              {editable ? (
                                <>
                                  <IconButton
                                    label={`Edit ${tool.name}`}
                                    onClick={() => setDialog({ kind: "tool", value: tool })}
                                  >
                                    <Pencil size={15} />
                                  </IconButton>
                                  <IconButton
                                    label={`Delete ${tool.name}`}
                                    danger
                                    onClick={() =>
                                      void perform(async () => {
                                        await api.deleteTool(
                                          service.id,
                                          version.id,
                                          tool.id,
                                          version.revision,
                                        );
                                        await loadService(service.id);
                                      }, "Tool deleted")
                                    }
                                  >
                                    <Trash2 size={15} />
                                  </IconButton>
                                </>
                              ) : null}
                            </span>
                          </div>
                        ))}
                        {serviceTools.length === 0 ? (
                          <div className="table-empty">
                            <Code2 size={22} />
                            No Tools configured
                          </div>
                        ) : null}
                      </div>
                    </>
                  ) : null}

                  {tab === "prompts" ? (
                    <>
                      <div className="section-heading">
                        <div>
                          <h2>Prompts</h2>
                          <p>Server-rendered message templates.</p>
                        </div>
                        {editable ? (
                          <button
                            className="button secondary"
                            type="button"
                            onClick={() => setDialog({ kind: "prompt" })}
                          >
                            <Plus size={16} />
                            Add Prompt
                          </button>
                        ) : null}
                      </div>
                      <div className="prompt-grid">
                        {servicePrompts.map((prompt) => (
                          <article className="prompt-item" key={prompt.id}>
                            <header>
                              <span className="prompt-icon">
                                <ScrollText size={18} />
                              </span>
                              <div>
                                <h3>{prompt.name}</h3>
                                <p>{prompt.title ?? "Untitled prompt"}</p>
                              </div>
                            </header>
                            <div className="prompt-meta">
                              <span>{prompt.arguments.length} arguments</span>
                              <span>{prompt.messages.length} messages</span>
                            </div>
                            <pre>{prompt.messages[0]?.content.text}</pre>
                            <footer>
                              <button
                                className="text-button"
                                type="button"
                                onClick={() => {
                                  setPreviewMessages(null);
                                  setPreviewError("");
                                  setDialog({ kind: "preview-prompt", value: prompt });
                                }}
                              >
                                <Play size={14} />
                                Preview
                              </button>
                              {editable ? (
                                <span>
                                  <IconButton
                                    label={`Edit ${prompt.name}`}
                                    onClick={() => setDialog({ kind: "prompt", value: prompt })}
                                  >
                                    <Pencil size={15} />
                                  </IconButton>
                                  <IconButton
                                    label={`Delete ${prompt.name}`}
                                    danger
                                    onClick={() =>
                                      void perform(async () => {
                                        await api.deletePrompt(
                                          service.id,
                                          version.id,
                                          prompt.id,
                                          version.revision,
                                        );
                                        await loadService(service.id);
                                      }, "Prompt deleted")
                                    }
                                  >
                                    <Trash2 size={15} />
                                  </IconButton>
                                </span>
                              ) : null}
                            </footer>
                          </article>
                        ))}
                        {servicePrompts.length === 0 ? (
                          <div className="table-empty">
                            <ScrollText size={22} />
                            No Prompts configured
                          </div>
                        ) : null}
                      </div>
                    </>
                  ) : null}

                  {tab === "versions" ? (
                    <>
                      <div className="section-heading">
                        <div>
                          <h2>Versions</h2>
                          <p>Immutable publication history.</p>
                        </div>
                      </div>
                      <div className="version-list">
                        {versions.map((item) => (
                          <button
                            type="button"
                            key={item.id}
                            className={item.id === version.id ? "active" : ""}
                            onClick={() => setSelectedVersionId(item.id)}
                          >
                            <span className="version-number">v{item.versionNumber}</span>
                            <StatusBadge status={item.status} />
                            <span>
                              {item.tools.length} Tools · {item.prompts.length} Prompts
                            </span>
                            <code>rev {item.revision}</code>
                          </button>
                        ))}
                      </div>
                    </>
                  ) : null}
                </section>
              </>
            )}
          </>
        ) : primaryView === "builds" ? (
          <BuildsView api={api} />
        ) : primaryView === "clients" ? (
          <ClientsView api={api} services={services} role={role} />
        ) : (
          <AuditView api={api} role={role} />
        )}
      </main>

      {dialog?.kind === "create-service" ? (
        <Modal title="New managed service" onClose={() => setDialog(null)}>
          <ServiceForm
            busy={busy}
            onCancel={() => setDialog(null)}
            onSubmit={async (value) =>
              perform(async () => {
                const created = await api.createService(value);
                setServices((items) => [created.service, ...items]);
                setSelectedServiceId(created.service.id);
                setDialog(null);
              }, "Service created")
            }
          />
        </Modal>
      ) : null}

      {dialog?.kind === "edit-service" && service ? (
        <Modal title="Edit service" onClose={() => setDialog(null)}>
          <ServiceForm
            initial={service}
            busy={busy}
            onCancel={() => setDialog(null)}
            onSubmit={async (value) =>
              perform(async () => {
                const updated = await api.updateService(service.id, service.revision, value);
                setService(updated);
                setServices((items) =>
                  items.map((item) => (item.id === updated.id ? updated : item)),
                );
                setDialog(null);
              }, "Service updated")
            }
          />
        </Modal>
      ) : null}

      {dialog?.kind === "tool" && service && version ? (
        <Modal title={dialog.value ? "Edit Tool" : "Add Tool"} onClose={() => setDialog(null)}>
          <ToolForm
            initial={dialog.value}
            busy={busy}
            onCancel={() => setDialog(null)}
            onSubmit={async (value) =>
              perform(
                async () => {
                  const updated = dialog.value
                    ? await api.updateTool(
                        service.id,
                        version.id,
                        dialog.value.id,
                        version.revision,
                        value,
                      )
                    : await api.addTool(service.id, version.id, version.revision, value);
                  await replaceVersion(updated);
                  setDialog(null);
                },
                dialog.value ? "Tool updated" : "Tool added",
              )
            }
          />
        </Modal>
      ) : null}

      {dialog?.kind === "prompt" && service && version ? (
        <Modal title={dialog.value ? "Edit Prompt" : "Add Prompt"} onClose={() => setDialog(null)}>
          <PromptForm
            initial={dialog.value}
            busy={busy}
            onCancel={() => setDialog(null)}
            onSubmit={async (value) =>
              perform(
                async () => {
                  const updated = dialog.value
                    ? await api.updatePrompt(
                        service.id,
                        version.id,
                        dialog.value.id,
                        version.revision,
                        value,
                      )
                    : await api.addPrompt(service.id, version.id, version.revision, value);
                  await replaceVersion(updated);
                  setDialog(null);
                },
                dialog.value ? "Prompt updated" : "Prompt added",
              )
            }
          />
        </Modal>
      ) : null}

      {dialog?.kind === "preview-prompt" && service && version ? (
        <Modal title={`Preview ${dialog.value.name}`} onClose={() => setDialog(null)}>
          <PromptPreviewForm
            prompt={dialog.value}
            busy={busy}
            messages={previewMessages}
            error={previewError}
            onCancel={() => setDialog(null)}
            onSubmit={async (argumentsByName) => {
              setBusy(true);
              setPreviewMessages(null);
              setPreviewError("");
              try {
                const preview = await api.previewPrompt(
                  service.id,
                  version.id,
                  dialog.value.id,
                  argumentsByName,
                );
                setPreviewMessages(preview.messages);
              } catch (cause) {
                setPreviewError(messageFrom(cause));
              } finally {
                setBusy(false);
              }
            }}
          />
        </Modal>
      ) : null}
    </div>
  );
}
