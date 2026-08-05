import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ApiOutlined,
  AuditOutlined,
  BuildOutlined,
  CheckCircleFilled,
  CodeOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  FileTextOutlined,
  LoadingOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  RocketOutlined,
  SearchOutlined,
  TeamOutlined,
  ToolOutlined,
  UndoOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import {
  addPrompt,
  addTool,
  buildVersion,
  createService,
  deletePrompt,
  deleteService,
  deleteTool,
  disableService,
  enableService,
  forkDraftVersion,
  listServices,
  listVersions,
  previewPrompt,
  publishVersion,
  resetVersionToDraft,
  rollbackVersion,
  uploadArtifact,
  updatePrompt,
  updateService,
  updateTool,
  validateVersion,
  type McpPrompt,
  type McpService,
  type McpTool,
  type McpVersion,
} from "./api.js";
import { callGatewayTool } from "./gateway.js";
import { AuditView, BuildsView, ClientsView, type McpManagementView } from "./McpOperations.js";

type Asset = { kind: "tool"; value: McpTool } | { kind: "prompt"; value: McpPrompt };
type AssetTab = "tools" | "prompts";
type DialogState =
  | { kind: "service"; initial?: McpService }
  | { kind: "tool"; initial?: McpTool }
  | { kind: "prompt"; initial?: McpPrompt }
  | null;

function latestVersion(versions: McpVersion[]): McpVersion | null {
  return [...versions].sort((left, right) => right.versionNumber - left.versionNumber)[0] ?? null;
}

export function McpWorkspace() {
  const [view, setView] = useState<McpManagementView>("services");
  const [services, setServices] = useState<McpService[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [versions, setVersions] = useState<McpVersion[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [asset, setAsset] = useState<Asset | null>(null);
  const [tab, setTab] = useState<AssetTab>("tools");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [serviceBusy, setServiceBusy] = useState(false);

  const loadServices = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await listServices();
      setServices(next);
      setSelectedId((current) =>
        next.some((service) => service.id === current) ? current : (next[0]?.id ?? null),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => void loadServices(), [loadServices]);

  useEffect(() => {
    if (!selectedId) {
      setVersions([]);
      setSelectedVersionId(null);
      return;
    }
    let cancelled = false;
    setAsset(null);
    setVersions([]);
    setSelectedVersionId(null);
    listVersions(selectedId)
      .then((next) => {
        if (cancelled) return;
        setVersions(next);
        setSelectedVersionId(latestVersion(next)?.id ?? null);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const selectedService = services.find((service) => service.id === selectedId) ?? null;
  const version =
    versions.find((candidate) => candidate.id === selectedVersionId) ?? latestVersion(versions);
  const assets = useMemo(() => {
    const query = search.trim().toLowerCase();
    const values = tab === "tools" ? (version?.tools ?? []) : (version?.prompts ?? []);
    return values.filter((item) => {
      if (!query) return true;
      return `${item.name} ${item.description ?? ""}`.toLowerCase().includes(query);
    });
  }, [search, tab, version]);

  const performServiceAction = async (action: () => Promise<void>) => {
    setServiceBusy(true);
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setServiceBusy(false);
    }
  };

  const refreshSelected = useCallback(
    async (preferredVersionId?: string) => {
      setError(null);
      try {
        const nextServices = await listServices();
        const nextSelectedId = selectedId ?? nextServices[0]?.id ?? null;
        const nextVersions = nextSelectedId ? await listVersions(nextSelectedId) : [];
        setServices(nextServices);
        setSelectedId(nextSelectedId);
        setVersions(nextVersions);
        setSelectedVersionId((current) => {
          const preferred = preferredVersionId ?? current;
          return nextVersions.some((item) => item.id === preferred)
            ? (preferred ?? null)
            : (latestVersion(nextVersions)?.id ?? null);
        });
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
        throw reason;
      }
    },
    [selectedId],
  );

  useEffect(() => {
    if (!selectedId || (version?.status !== "VALIDATING" && version?.status !== "BUILDING")) {
      return;
    }
    const timer = window.setInterval(() => {
      listVersions(selectedId)
        .then((next) => setVersions(next))
        .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [selectedId, version?.status]);

  useEffect(() => {
    if (!asset || !version) return;
    const items = asset.kind === "tool" ? version.tools : version.prompts;
    const current = items.find((item) => item.id === asset.value.id);
    if (!current) setAsset(null);
    else if (current !== asset.value) setAsset({ kind: asset.kind, value: current } as Asset);
  }, [asset?.kind, asset?.value.id, version?.id, version?.revision]);

  return (
    <section className="domain-workspace mcp-workspace">
      <header className="domain-header">
        <div>
          <p className="domain-eyebrow">资源编排 / MCP</p>
          <h1>
            {view === "services"
              ? "MCP 服务"
              : view === "builds"
                ? "构建任务"
                : view === "clients"
                  ? "客户端授权"
                  : "审计事件"}
          </h1>
        </div>
        <nav className="mcp-management-tabs" aria-label="MCP 管理视图">
          <button
            type="button"
            className={view === "services" ? "is-active" : ""}
            onClick={() => setView("services")}
          >
            <ApiOutlined /> 服务
          </button>
          <button
            type="button"
            className={view === "builds" ? "is-active" : ""}
            onClick={() => setView("builds")}
          >
            <BuildOutlined /> 构建
          </button>
          <button
            type="button"
            className={view === "clients" ? "is-active" : ""}
            onClick={() => setView("clients")}
          >
            <TeamOutlined /> 客户端
          </button>
          <button
            type="button"
            className={view === "audit" ? "is-active" : ""}
            onClick={() => setView("audit")}
          >
            <AuditOutlined /> 审计
          </button>
        </nav>
        <div className="domain-header-actions">
          {view === "services" ? (
            <>
              {selectedService ? (
                <>
                  <button
                    className="icon-command"
                    type="button"
                    title="编辑服务"
                    aria-label="编辑服务"
                    disabled={serviceBusy}
                    onClick={() => setDialog({ kind: "service", initial: selectedService })}
                  >
                    <EditOutlined />
                  </button>
                  <button
                    className="icon-command"
                    type="button"
                    title={selectedService.status === "DISABLED" ? "启用服务" : "禁用服务"}
                    aria-label={selectedService.status === "DISABLED" ? "启用服务" : "禁用服务"}
                    disabled={
                      serviceBusy ||
                      (selectedService.status !== "ACTIVE" && selectedService.status !== "DISABLED")
                    }
                    onClick={() => {
                      const enabling = selectedService.status === "DISABLED";
                      if (
                        !window.confirm(
                          `${enabling ? "启用" : "禁用"}服务 ${selectedService.name}？`,
                        )
                      )
                        return;
                      void performServiceAction(async () => {
                        if (enabling)
                          await enableService(selectedService.id, selectedService.revision);
                        else await disableService(selectedService.id, selectedService.revision);
                        await refreshSelected();
                      });
                    }}
                  >
                    <CheckCircleFilled />
                  </button>
                  <button
                    className="icon-command danger"
                    type="button"
                    title="删除服务"
                    aria-label="删除服务"
                    disabled={serviceBusy}
                    onClick={() => {
                      if (!window.confirm(`永久删除服务 ${selectedService.name}？`)) return;
                      void performServiceAction(async () => {
                        await deleteService(selectedService.id, selectedService.revision);
                        const next = await listServices();
                        setServices(next);
                        setSelectedId(next[0]?.id ?? null);
                      });
                    }}
                  >
                    <DeleteOutlined />
                  </button>
                </>
              ) : null}
              <button
                className="studio-button secondary"
                type="button"
                onClick={() => void refreshSelected()}
              >
                <ReloadOutlined /> 刷新
              </button>
              <button
                className="studio-button primary"
                type="button"
                onClick={() => setDialog({ kind: "service" })}
              >
                <PlusOutlined /> 新建服务
              </button>
            </>
          ) : null}
        </div>
      </header>

      {view === "services" ? (
        <>
          <div className="domain-grid">
            <aside className="resource-panel">
              <div className="panel-heading">
                <span>服务列表</span>
                <span className="count-badge">{services.length}</span>
              </div>
              {loading ? <div className="panel-state">正在连接控制面...</div> : null}
              {error ? (
                <div className="connection-state" role="alert">
                  <span>控制面未连接</span>
                  <small>{error}</small>
                  <button type="button" onClick={() => void loadServices()}>
                    重新连接
                  </button>
                </div>
              ) : null}
              {!loading && !error && services.length === 0 ? (
                <div className="panel-state">还没有 MCP 服务</div>
              ) : null}
              <div className="resource-list">
                {services.map((service) => (
                  <button
                    type="button"
                    key={service.id}
                    className={`resource-item${selectedId === service.id ? " is-active" : ""}`}
                    onClick={() => setSelectedId(service.id)}
                  >
                    <span className={`resource-icon status-${service.status.toLowerCase()}`}>
                      <ApiOutlined />
                    </span>
                    <span className="resource-copy">
                      <b>{service.name}</b>
                      <small>/{service.slug}</small>
                    </span>
                    <span className="status-dot" title={service.status} />
                  </button>
                ))}
              </div>
            </aside>

            <div className="asset-panel">
              <div className="asset-toolbar">
                <div className="segmented-control" aria-label="MCP 资源类型">
                  <button
                    type="button"
                    className={tab === "tools" ? "is-active" : ""}
                    onClick={() => setTab("tools")}
                  >
                    <ToolOutlined /> Tools <span>{version?.tools.length ?? 0}</span>
                  </button>
                  <button
                    type="button"
                    className={tab === "prompts" ? "is-active" : ""}
                    onClick={() => setTab("prompts")}
                  >
                    <FileTextOutlined /> Prompts <span>{version?.prompts.length ?? 0}</span>
                  </button>
                </div>
                <label className="studio-search">
                  <SearchOutlined />
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="搜索资源"
                    autoComplete="off"
                    autoFocus={false}
                  />
                </label>
                <button
                  type="button"
                  className="icon-command"
                  title={tab === "tools" ? "添加 Tool" : "添加 Prompt"}
                  aria-label={tab === "tools" ? "添加 Tool" : "添加 Prompt"}
                  disabled={version?.status !== "DRAFT"}
                  onClick={() => setDialog({ kind: tab === "tools" ? "tool" : "prompt" })}
                >
                  <PlusOutlined />
                </button>
              </div>

              {selectedService && version ? (
                <VersionLifecycle
                  key={version.id}
                  service={selectedService}
                  version={version}
                  versions={versions}
                  onSelect={(versionId) => {
                    setSelectedVersionId(versionId);
                    setAsset(null);
                  }}
                  onRefresh={refreshSelected}
                />
              ) : null}

              <div className="asset-list">
                {assets.map((item) => {
                  const current: Asset =
                    tab === "tools"
                      ? { kind: "tool", value: item as McpTool }
                      : { kind: "prompt", value: item as McpPrompt };
                  const selected =
                    asset?.kind === current.kind && asset.value.id === current.value.id;
                  return (
                    <button
                      type="button"
                      className={`asset-row${selected ? " is-active" : ""}`}
                      key={item.id}
                      onClick={() => setAsset(current)}
                    >
                      <span className={`asset-kind kind-${tab}`}>
                        {tab === "tools" ? <CodeOutlined /> : <FileTextOutlined />}
                      </span>
                      <span className="asset-copy">
                        <b>{item.name}</b>
                        <small>
                          {item.description ||
                            (tab === "tools" ? "未填写工具说明" : "未填写提示词说明")}
                        </small>
                      </span>
                      <span className="asset-meta">
                        {tab === "tools"
                          ? (item as McpTool).handler
                          : `${(item as McpPrompt).arguments.length} 参数`}
                      </span>
                    </button>
                  );
                })}
                {!selectedService ? (
                  <EmptyAssetState icon={<ApiOutlined />} text="从左侧选择一个 MCP 服务" />
                ) : null}
                {selectedService && !version ? (
                  <EmptyAssetState icon={<CodeOutlined />} text="该服务还没有可用版本" />
                ) : null}
                {selectedService && version && assets.length === 0 ? (
                  <EmptyAssetState icon={<SearchOutlined />} text="没有匹配的资源" />
                ) : null}
              </div>
            </div>

            <aside className="inspector-panel">
              <div className="panel-heading">配置与预览</div>
              {asset ? (
                <AssetInspector
                  service={selectedService!}
                  version={version!}
                  asset={asset}
                  onEdit={() =>
                    setDialog(
                      asset.kind === "tool"
                        ? { kind: "tool", initial: asset.value }
                        : { kind: "prompt", initial: asset.value },
                    )
                  }
                  onDelete={() => {
                    if (!window.confirm(`删除 ${asset.value.name}？`)) return;
                    void performServiceAction(async () => {
                      if (asset.kind === "tool")
                        await deleteTool(
                          selectedService!.id,
                          version!.id,
                          asset.value.id,
                          version!.revision,
                        );
                      else
                        await deletePrompt(
                          selectedService!.id,
                          version!.id,
                          asset.value.id,
                          version!.revision,
                        );
                      setAsset(null);
                      await refreshSelected();
                    });
                  }}
                />
              ) : (
                <div className="inspector-empty">
                  <CheckCircleFilled />
                  <p>选择一个 Tool 或 Prompt</p>
                  <small>这里会显示参数结构和运行预览。</small>
                </div>
              )}
            </aside>
          </div>

          {dialog?.kind === "service" ? (
            <ServiceDialog
              initial={dialog.initial}
              onClose={() => setDialog(null)}
              onSaved={refreshSelected}
            />
          ) : null}
          {dialog?.kind === "tool" && selectedService && version ? (
            <ToolDialog
              service={selectedService}
              version={version}
              initial={dialog.initial}
              onClose={() => setDialog(null)}
              onSaved={refreshSelected}
            />
          ) : null}
          {dialog?.kind === "prompt" && selectedService && version ? (
            <PromptDialog
              service={selectedService}
              version={version}
              initial={dialog.initial}
              onClose={() => setDialog(null)}
              onSaved={refreshSelected}
            />
          ) : null}
        </>
      ) : view === "builds" ? (
        <BuildsView />
      ) : view === "clients" ? (
        <ClientsView services={services} />
      ) : (
        <AuditView />
      )}
    </section>
  );
}

function VersionLifecycle({
  service,
  version,
  versions,
  onSelect,
  onRefresh,
}: {
  service: McpService;
  version: McpVersion;
  versions: McpVersion[];
  onSelect: (versionId: string) => void;
  onRefresh: (preferredVersionId?: string) => Promise<void>;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const packageRetryable = ["DRAFT", "FAILED", "VALIDATING", "BUILDING"].includes(version.status);
  const artifactReady =
    version.artifactDigest !== null &&
    version.artifactObjectKey !== null &&
    version.artifactSize !== null;
  const buildable =
    (version.status === "DRAFT" || version.status === "FAILED") &&
    artifactReady &&
    version.tools.length > 0;
  const processing = version.status === "VALIDATING" || version.status === "BUILDING";

  const perform = async (
    label: string,
    success: string,
    action: () => Promise<string | undefined>,
  ) => {
    setBusy(label);
    setNotice(null);
    setError(null);
    try {
      const preferredVersionId = await action();
      await onRefresh(preferredVersionId ?? version.id);
      setNotice(success);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="version-lifecycle" aria-label="版本生命周期">
      <div className="version-lifecycle-main">
        <label className="version-picker">
          <span>版本</span>
          <select value={version.id} onChange={(event) => onSelect(event.target.value)}>
            {[...versions]
              .sort((left, right) => right.versionNumber - left.versionNumber)
              .map((item) => (
                <option value={item.id} key={item.id}>
                  v{item.versionNumber} · {item.status}
                </option>
              ))}
          </select>
        </label>
        <span className={`version-status version-${version.status.toLowerCase()}`}>
          {processing ? <LoadingOutlined spin /> : null}
          {version.status}
        </span>
        <span className="version-revision">revision {version.revision}</span>
        <code className="gateway-endpoint">/mcp/services/{service.slug}</code>
        <div className="lifecycle-actions">
          {packageRetryable ? (
            <>
              <input
                ref={fileInput}
                className="visually-hidden"
                type="file"
                accept=".zip,application/zip"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  void perform("upload", "代码包已提交检查", async () => {
                    const result = await uploadArtifact(
                      service.id,
                      version.id,
                      version.revision,
                      file,
                    );
                    return result.version.id;
                  });
                }}
              />
              <button
                className="studio-button secondary compact"
                type="button"
                title="上传 ZIP 代码资源包"
                disabled={busy !== null}
                onClick={() => fileInput.current?.click()}
              >
                {busy === "upload" ? <LoadingOutlined spin /> : <UploadOutlined />} 上传代码包
              </button>
              <button
                className="studio-button secondary compact"
                type="button"
                title={
                  buildable
                    ? "构建并检查 Tool 运行镜像"
                    : processing
                      ? "等待当前检查或构建任务完成"
                      : "需要先完成代码包检查"
                }
                disabled={busy !== null || !buildable}
                onClick={() =>
                  void perform("build", "镜像构建任务已提交", async () => {
                    const result = await buildVersion(service.id, version.id, version.revision);
                    return result.version.id;
                  })
                }
              >
                {busy === "build" ? <LoadingOutlined spin /> : <PlayCircleOutlined />} 构建镜像
              </button>
            </>
          ) : null}
          {version.status === "DRAFT" && version.tools.length === 0 ? (
            <button
              className="studio-button secondary compact"
              type="button"
              disabled={busy !== null}
              onClick={() =>
                void perform("validate", "Prompt 版本已通过校验", async () => {
                  const result = await validateVersion(service.id, version.id, version.revision);
                  return result.id;
                })
              }
            >
              {busy === "validate" ? <LoadingOutlined spin /> : <CheckCircleFilled />} 校验版本
            </button>
          ) : null}
          {version.status === "READY" ? (
            <>
              <button
                className="studio-button primary compact"
                type="button"
                disabled={busy !== null}
                onClick={() =>
                  void perform("publish", "版本已发布到 Gateway", async () => {
                    const result = await publishVersion(service.id, version.id, version.revision);
                    return result.version.id;
                  })
                }
              >
                {busy === "publish" ? <LoadingOutlined spin /> : <RocketOutlined />} 发布
              </button>
              <button
                className="studio-button secondary compact"
                type="button"
                title="重置为草稿"
                aria-label="重置为草稿"
                disabled={busy !== null}
                onClick={() => {
                  if (!window.confirm("将该版本重置为草稿？已构建的镜像引用会被清除。")) return;
                  void perform("reset", "版本已重置为草稿", async () => {
                    const result = await resetVersionToDraft(
                      service.id,
                      version.id,
                      version.revision,
                    );
                    return result.id;
                  });
                }}
              >
                {busy === "reset" ? <LoadingOutlined spin /> : <UndoOutlined />} 重置
              </button>
            </>
          ) : null}
          {version.status === "PUBLISHED" || version.status === "SUPERSEDED" ? (
            <button
              className="studio-button secondary compact"
              type="button"
              disabled={busy !== null}
              onClick={() => {
                if (!window.confirm(`从 v${version.versionNumber} 创建新草稿版本？`)) return;
                void perform("fork", "新草稿版本已创建", async () => {
                  const result = await forkDraftVersion(service.id, version.id);
                  return result.id;
                });
              }}
            >
              {busy === "fork" ? <LoadingOutlined spin /> : <CopyOutlined />} 创建草稿
            </button>
          ) : null}
          {service.status === "ACTIVE" &&
          service.currentVersionId !== version.id &&
          (version.status === "READY" || version.status === "SUPERSEDED") ? (
            <button
              className="studio-button secondary compact"
              type="button"
              title={`回滚到 v${version.versionNumber}`}
              aria-label={`回滚到 v${version.versionNumber}`}
              disabled={busy !== null}
              onClick={() => {
                if (!window.confirm(`将 ${service.name} 回滚到 v${version.versionNumber}？`))
                  return;
                void perform("rollback", `已回滚到 v${version.versionNumber}`, async () => {
                  const result = await rollbackVersion(service.id, version.id, version.revision);
                  return result.version.id;
                });
              }}
            >
              {busy === "rollback" ? <LoadingOutlined spin /> : <UndoOutlined />} 回滚
            </button>
          ) : null}
        </div>
      </div>
      <div className="version-artifacts">
        <span title={version.artifactDigest ?? undefined}>
          代码包 {version.artifactSize === null ? "未上传" : formatBytes(version.artifactSize)}
        </span>
        <span title={version.entry ?? undefined}>入口 {version.entry ?? "待检查"}</span>
        <span title={version.imageDigest ?? undefined}>
          镜像 {version.imageDigest ? shortDigest(version.imageDigest) : "未构建"}
        </span>
        {notice ? <strong className="lifecycle-notice">{notice}</strong> : null}
        {error ? (
          <strong className="lifecycle-error" role="alert">
            {error}
          </strong>
        ) : null}
      </div>
    </section>
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function shortDigest(value: string): string {
  return value.length > 20 ? `${value.slice(0, 16)}...` : value;
}

function EmptyAssetState({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="asset-empty">
      {icon}
      <p>{text}</p>
    </div>
  );
}

function AssetInspector({
  service,
  version,
  asset,
  onEdit,
  onDelete,
}: {
  service: McpService;
  version: McpVersion;
  asset: Asset;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<string>("");
  const [apiKey, setApiKey] = useState("");
  const [toolResultError, setToolResultError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValues({});
    setPreview("");
    setToolResultError(false);
    setError(null);
  }, [asset.kind, asset.value.id, service.id]);

  const properties =
    asset.kind === "tool"
      ? Object.entries(
          (asset.value.inputSchema.properties ?? {}) as Record<
            string,
            { type?: string; description?: string }
          >,
        )
      : asset.value.arguments.map(
          (argument) =>
            [argument.name, { type: "string", description: argument.description }] as const,
        );

  const runPreview = async () => {
    setBusy(true);
    setError(null);
    setPreview("");
    setToolResultError(false);
    try {
      if (asset.kind === "prompt") {
        const result = await previewPrompt(service.id, version.id, asset.value.id, values);
        setPreview(
          result.messages
            .map((message) => `${message.role.toUpperCase()}\n${message.content.text}`)
            .join("\n\n"),
        );
      } else {
        const input = Object.fromEntries(
          properties
            .filter(([key]) => Object.prototype.hasOwnProperty.call(values, key))
            .map(([key, schema]) => [key, coerceValue(values[key] ?? "", schema.type)]),
        );
        const result = await callGatewayTool({
          serviceSlug: service.slug,
          apiKey,
          toolName: asset.value.name,
          arguments: input,
        });
        setToolResultError("isError" in result && result.isError === true);
        setPreview(JSON.stringify(result, null, 2));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const currentGatewayVersion =
    service.status === "ACTIVE" &&
    service.currentVersionId === version.id &&
    version.status === "PUBLISHED";
  const gatewayState =
    service.status !== "ACTIVE"
      ? "服务未启用，Gateway 不接受调用"
      : service.currentVersionId !== version.id
        ? "Gateway 只执行当前已发布版本"
        : version.status !== "PUBLISHED"
          ? "当前版本尚未发布"
          : null;

  return (
    <div className="inspector-content">
      <div className="inspector-title-row">
        <span className={`asset-kind kind-${asset.kind === "tool" ? "tools" : "prompts"}`}>
          {asset.kind === "tool" ? <CodeOutlined /> : <FileTextOutlined />}
        </span>
        <div>
          <h2>{asset.value.name}</h2>
          <p>{asset.value.description || "暂无说明"}</p>
        </div>
        {version.status === "DRAFT" ? (
          <span className="inspector-title-actions">
            <button
              className="icon-command"
              type="button"
              title="编辑"
              aria-label="编辑"
              onClick={onEdit}
            >
              <EditOutlined />
            </button>
            <button
              className="icon-command danger"
              type="button"
              title="删除"
              aria-label="删除"
              onClick={onDelete}
            >
              <DeleteOutlined />
            </button>
          </span>
        ) : null}
      </div>
      {asset.kind === "tool" ? (
        <>
          <CodeBlock value={JSON.stringify(asset.value.inputSchema, null, 2)} />
          <label className="studio-field gateway-key-field">
            <span>
              Gateway API Key
              <small>Bearer</small>
            </span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="mcp_..."
            />
          </label>
          {gatewayState ? <p className="gateway-call-state">{gatewayState}</p> : null}
        </>
      ) : null}
      <div className="inspector-section-title">输入参数</div>
      {properties.length === 0 ? <p className="muted-copy">该资源不需要参数。</p> : null}
      {properties.map(([name, schema]) => (
        <label className="studio-field" key={name}>
          <span>
            {name}
            <small>{schema.type ?? "string"}</small>
          </span>
          <input
            value={values[name] ?? ""}
            onChange={(event) => setValues({ ...values, [name]: event.target.value })}
            placeholder={schema.description ?? "输入测试值"}
          />
        </label>
      ))}
      <button
        className="studio-button primary full-width"
        type="button"
        disabled={
          busy || (asset.kind === "tool" && (!currentGatewayVersion || apiKey.trim().length === 0))
        }
        onClick={() => void runPreview()}
      >
        {busy ? "执行中..." : asset.kind === "prompt" ? "渲染 Prompt" : "调用 Tool"}
      </button>
      {error ? <p className="field-message error">{error}</p> : null}
      {preview ? (
        <div className={toolResultError ? "gateway-result is-error" : "gateway-result"}>
          {asset.kind === "tool" ? (
            <div className="gateway-result-heading">
              <span>CallToolResult</span>
              <strong>{toolResultError ? "执行错误" : "执行成功"}</strong>
            </div>
          ) : null}
          <CodeBlock value={preview} />
        </div>
      ) : null}
    </div>
  );
}

function coerceValue(value: string, type?: string): unknown {
  if (type === "number" || type === "integer") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`无法将 ${value} 转换为数字`);
    return parsed;
  }
  if (type === "boolean") {
    if (value !== "true" && value !== "false") throw new Error("布尔参数必须是 true 或 false");
    return value === "true";
  }
  if (type === "object" || type === "array") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      throw new Error(`${type === "object" ? "对象" : "数组"}参数必须是合法 JSON`);
    }
  }
  if (type === "null") return null;
  return value;
}

function CodeBlock({ value }: { value: string }) {
  return <pre className="studio-code">{value}</pre>;
}

function ServiceDialog({
  initial,
  onClose,
  onSaved,
}: {
  initial?: McpService;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    try {
      const value = {
        name: String(form.get("name") ?? "").trim(),
        slug: String(form.get("slug") ?? "").trim(),
      };
      if (initial) await updateService(initial.id, initial.revision, value);
      else await createService(value);
      await onSaved();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={initial ? "编辑 MCP 服务" : "新建 MCP 服务"} onClose={onClose}>
      <form className="dialog-form" onSubmit={(event) => void submit(event)}>
        <label className="studio-field">
          <span>服务名称</span>
          <input required name="name" defaultValue={initial?.name} placeholder="例如：文档分析" />
        </label>
        <label className="studio-field">
          <span>Slug</span>
          <input
            required
            name="slug"
            defaultValue={initial?.slug}
            pattern="[a-z][a-z0-9-]*"
            placeholder="document-analysis"
          />
        </label>
        {error ? <p className="field-message error">{error}</p> : null}
        <DialogActions busy={busy} onClose={onClose} />
      </form>
    </Dialog>
  );
}

function ToolDialog({
  service,
  version,
  initial,
  onClose,
  onSaved,
}: {
  service: McpService;
  version: McpVersion;
  initial?: McpTool;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    try {
      const schema = JSON.parse(String(form.get("schema"))) as Record<string, unknown>;
      const value = {
        name: String(form.get("name") ?? "").trim(),
        handler: String(form.get("handler") ?? "").trim(),
        description: String(form.get("description") ?? "").trim(),
        inputSchema: schema,
      };
      if (initial) await updateTool(service.id, version.id, initial.id, version.revision, value);
      else await addTool(service.id, version.id, version.revision, value);
      await onSaved();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Schema 必须是合法 JSON");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={initial ? "编辑 Tool" : "添加 Tool"} onClose={onClose}>
      <form className="dialog-form" onSubmit={(event) => void submit(event)}>
        <div className="field-grid">
          <label className="studio-field">
            <span>Tool 名称</span>
            <input required name="name" defaultValue={initial?.name} />
          </label>
          <label className="studio-field">
            <span>Handler 导出名</span>
            <input required name="handler" defaultValue={initial?.handler} />
          </label>
        </div>
        <label className="studio-field">
          <span>说明</span>
          <input name="description" defaultValue={initial?.description} />
        </label>
        <label className="studio-field">
          <span>输入 Schema</span>
          <textarea
            name="schema"
            rows={9}
            defaultValue={JSON.stringify(
              initial?.inputSchema ?? {
                type: "object",
                properties: {},
                additionalProperties: false,
              },
              null,
              2,
            )}
          />
        </label>
        {error ? <p className="field-message error">{error}</p> : null}
        <DialogActions busy={busy} onClose={onClose} />
      </form>
    </Dialog>
  );
}

function PromptDialog({
  service,
  version,
  initial,
  onClose,
  onSaved,
}: {
  service: McpService;
  version: McpVersion;
  initial?: McpPrompt;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const value = {
        name: String(form.get("name") ?? "").trim(),
        title: String(form.get("title") ?? "").trim() || undefined,
        description: String(form.get("description") ?? "").trim() || undefined,
        arguments: JSON.parse(String(form.get("arguments"))) as McpPrompt["arguments"],
        messages: JSON.parse(String(form.get("messages"))) as McpPrompt["messages"],
      };
      if (initial) await updatePrompt(service.id, version.id, initial.id, version.revision, value);
      else await addPrompt(service.id, version.id, version.revision, value);
      await onSaved();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Prompt 配置必须是合法 JSON");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={initial ? "编辑 Prompt" : "添加 Prompt"} onClose={onClose}>
      <form className="dialog-form" onSubmit={(event) => void submit(event)}>
        <div className="field-grid">
          <label className="studio-field">
            <span>Prompt 名称</span>
            <input required name="name" defaultValue={initial?.name} />
          </label>
          <label className="studio-field">
            <span>标题</span>
            <input name="title" defaultValue={initial?.title} />
          </label>
        </div>
        <label className="studio-field">
          <span>说明</span>
          <input name="description" defaultValue={initial?.description} />
        </label>
        <label className="studio-field">
          <span>参数定义</span>
          <textarea
            name="arguments"
            rows={6}
            defaultValue={JSON.stringify(
              initial?.arguments ?? [{ name: "input", required: true }],
              null,
              2,
            )}
          />
        </label>
        <label className="studio-field">
          <span>消息模板</span>
          <textarea
            name="messages"
            rows={9}
            defaultValue={JSON.stringify(
              initial?.messages ?? [{ role: "user", content: { type: "text", text: "{{input}}" } }],
              null,
              2,
            )}
          />
        </label>
        {error ? <p className="field-message error">{error}</p> : null}
        <DialogActions busy={busy} onClose={onClose} />
      </form>
    </Dialog>
  );
}

function Dialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="studio-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="studio-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <h2>{title}</h2>
          <button type="button" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function DialogActions({ busy, onClose }: { busy: boolean; onClose: () => void }) {
  return (
    <div className="dialog-actions">
      <button className="studio-button secondary" type="button" onClick={onClose}>
        取消
      </button>
      <button className="studio-button primary" type="submit" disabled={busy}>
        {busy ? "保存中..." : "保存"}
      </button>
    </div>
  );
}
