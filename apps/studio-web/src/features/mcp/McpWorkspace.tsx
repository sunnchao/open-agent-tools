import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  Descriptions,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Select,
  Segmented,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
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
  SettingOutlined,
  ToolOutlined,
  UndoOutlined,
  UploadOutlined,
} from "../../lib/icons.js";
import { StudioPage } from "../../components/studio/StudioPageHeader.js";
import { StudioNotice, type StudioNoticeValue } from "../../components/studio/StudioNotice.js";
import { confirmAction } from "../../components/studio/confirmAction.js";
import {
  addPrompt,
  addTool,
  buildVersion,
  createRemoteService,
  createService,
  deletePrompt,
  deleteService,
  deleteTool,
  disableService,
  enableService,
  forkDraftVersion,
  getServiceEnvironment,
  listServices,
  listVersions,
  previewPrompt,
  publishVersion,
  resetVersionToDraft,
  rollbackVersion,
  testRemoteConnection,
  testSavedRemoteConnection,
  updatePrompt,
  updateRemoteConfig,
  updateService,
  updateServiceEnvironment,
  updateTool,
  uploadArtifact,
  validateVersion,
  type McpPrompt,
  type McpService,
  type McpTool,
  type McpVersion,
  type RemoteProbeResult,
  type RemoteServiceConfigInput,
  type RemoteTransport,
} from "./api.js";
import { callGatewayTool } from "./gateway.js";
import { AuditView, BuildsView, ClientsView, type McpManagementView } from "./McpOperations.js";
import { MarketplaceView } from "./MarketplaceView.js";
import { SlaPanel } from "./SlaPanel.js";
import { DebugSandbox } from "./DebugSandbox.js";
import { VersionLimits } from "./VersionLimits.js";

type Asset = { kind: "tool"; value: McpTool } | { kind: "prompt"; value: McpPrompt };
type AssetTab = "tools" | "prompts";
type DialogState =
  | { kind: "service"; initial?: McpService }
  | { kind: "environment"; service: McpService }
  | { kind: "tool"; initial?: McpTool }
  | { kind: "prompt"; initial?: McpPrompt }
  | null;

function latestVersion(versions: McpVersion[]): McpVersion | null {
  return [...versions].sort((left, right) => right.versionNumber - left.versionNumber)[0] ?? null;
}

const VIEW_OPTIONS: Array<{ value: McpManagementView; label: string }> = [
  { value: "services", label: "服务" },
  { value: "marketplace", label: "市场" },
  { value: "builds", label: "构建" },
  { value: "clients", label: "客户端" },
  { value: "audit", label: "审计" },
  { value: "sla", label: "SLA" },
  { value: "sandbox", label: "沙箱" },
];

const VIEW_TITLES: Record<McpManagementView, string> = {
  services: "MCP 服务",
  marketplace: "工具市场",
  builds: "构建任务",
  clients: "客户端授权",
  audit: "审计事件",
  sla: "工具 SLA",
  sandbox: "调试沙箱",
};

function serviceBadge(status: McpService["status"]): "success" | "warning" | "default" | "error" {
  if (status === "ACTIVE") return "success";
  if (status === "DISABLED") return "warning";
  if (status === "DELETED") return "error";
  return "default";
}

function versionTagColor(status: McpVersion["status"]): string {
  if (status === "PUBLISHED") return "success";
  if (status === "READY") return "processing";
  if (status === "FAILED") return "error";
  if (status === "VALIDATING" || status === "BUILDING") return "warning";
  return "default";
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
  const { message } = App.useApp();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [serviceBusy, setServiceBusy] = useState(false);
  const notice: StudioNoticeValue | null = error ? { type: "error", text: error } : null;

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

  const serviceActions =
    view === "services" ? (
      <Flex gap={8} align="center" wrap>
        {selectedService ? (
          <>
            <Tooltip title="编辑服务">
              <Button
                type="text"
                icon={<EditOutlined />}
                aria-label="编辑服务"
                disabled={serviceBusy}
                onClick={() => setDialog({ kind: "service", initial: selectedService })}
              />
            </Tooltip>
            <Button
              icon={<SettingOutlined />}
              disabled={serviceBusy}
              onClick={() => setDialog({ kind: "environment", service: selectedService })}
            >
              环境变量
            </Button>
            <Tooltip title={selectedService.status === "DISABLED" ? "启用服务" : "禁用服务"}>
              <Button
                type="text"
                icon={<CheckCircleFilled />}
                aria-label={selectedService.status === "DISABLED" ? "启用服务" : "禁用服务"}
                disabled={
                  serviceBusy ||
                  (selectedService.status !== "ACTIVE" && selectedService.status !== "DISABLED")
                }
                onClick={() => {
                  const enabling = selectedService.status === "DISABLED";
                  confirmAction({
                    title: `${enabling ? "启用" : "禁用"}服务“${selectedService.name}”？`,
                    content: enabling
                      ? "启用后 Gateway 将接受该服务的调用。"
                      : "禁用后 Gateway 将拒绝该服务的调用，已发布版本不受影响。",
                    okText: enabling ? "启用" : "禁用",
                    danger: !enabling,
                    onOk: () =>
                      void performServiceAction(async () => {
                        if (enabling)
                          await enableService(selectedService.id, selectedService.revision);
                        else await disableService(selectedService.id, selectedService.revision);
                        await refreshSelected();
                        message.success(`服务已${enabling ? "启用" : "禁用"}`);
                      }),
                  });
                }}
              />
            </Tooltip>
            <Tooltip title="删除服务">
              <Button
                type="text"
                danger
                icon={<DeleteOutlined />}
                aria-label="删除服务"
                disabled={serviceBusy}
                onClick={() => {
                  confirmAction({
                    title: `永久删除服务“${selectedService.name}”？`,
                    content: "服务及其版本、资产将一并删除，该操作不可恢复。",
                    onOk: () =>
                      void performServiceAction(async () => {
                        await deleteService(selectedService.id, selectedService.revision);
                        const next = await listServices();
                        setServices(next);
                        setSelectedId(next[0]?.id ?? null);
                        message.success("服务已删除");
                      }),
                  });
                }}
              />
            </Tooltip>
          </>
        ) : null}
        <Button icon={<ReloadOutlined />} onClick={() => void refreshSelected()}>
          刷新
        </Button>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => setDialog({ kind: "service" })}
        >
          新建服务
        </Button>
      </Flex>
    ) : undefined;

  return (
    <StudioPage
      eyebrow="资源编排 / MCP"
      title={VIEW_TITLES[view]}
      description="管理 MCP 服务、版本生命周期与资源资产。"
      actions={serviceActions}
      extra={
        <>
          <div style={{ padding: "12px 16px 0" }}>
            <Segmented<McpManagementView>
              aria-label="MCP 管理视图"
              value={view}
              onChange={(value) => setView(value)}
              options={VIEW_OPTIONS.map((item) => ({ ...item }))}
              block
            />
          </div>
          <StudioNotice notice={notice} />
        </>
      }
    >
      {view === "services" ? (
        <>
          <Flex
            className="studio-split-layout"
            gap={12}
            align="flex-start"
            style={{ flex: 1, minHeight: 0, padding: 16, overflow: "hidden" }}
          >
            <Card
              className="studio-split-layout__aside"
              size="small"
              title="服务列表"
              extra={<Tag>{services.length}</Tag>}
              style={{
                width: 280,
                flex: "0 0 auto",
                maxHeight: "100%",
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
              }}
              styles={{ body: { padding: 8, overflowY: "auto" } }}
            >
              {loading ? (
                <Flex justify="center" style={{ padding: 24 }}>
                  <Spin tip="正在连接控制面..." />
                </Flex>
              ) : null}
              {error ? (
                <Alert
                  type="error"
                  showIcon
                  message="控制面未连接"
                  description={error}
                  action={
                    <Button size="small" onClick={() => void loadServices()}>
                      重新连接
                    </Button>
                  }
                  style={{ marginBottom: 8 }}
                />
              ) : null}
              {!loading && !error && services.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有 MCP 服务" />
              ) : (
                <List
                  size="small"
                  dataSource={services}
                  rowKey="id"
                  renderItem={(service) => (
                    <List.Item
                      onClick={() => setSelectedId(service.id)}
                      style={{
                        cursor: "pointer",
                        borderRadius: 8,
                        padding: "8px 12px",
                        background: service.id === selectedId ? "var(--studio-selected)" : undefined,
                      }}
                    >
                      <List.Item.Meta
                        avatar={<Badge status={serviceBadge(service.status)} />}
                        title={
                          <Typography.Text strong ellipsis style={{ maxWidth: 150 }}>
                            {service.name}
                          </Typography.Text>
                        }
                        description={`/${service.slug}`}
                      />
                    </List.Item>
                  )}
                />
              )}
            </Card>

            <Flex
              className="studio-split-layout__main"
              vertical
              gap={12}
              style={{ flex: 1, minWidth: 0, overflowY: "auto" }}
            >
              <Card size="small">
                <Flex gap={8} align="center" wrap>
                  <Segmented<AssetTab>
                    aria-label="MCP 资源类型"
                    value={tab}
                    onChange={(value) => setTab(value)}
                    options={[
                      {
                        value: "tools",
                        label: `Tools ${version?.tools.length ?? 0}`,
                        icon: <ToolOutlined />,
                      },
                      {
                        value: "prompts",
                        label: `Prompts ${version?.prompts.length ?? 0}`,
                        icon: <FileTextOutlined />,
                      },
                    ]}
                  />
                  <Input.Search
                    allowClear
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="搜索资源"
                    style={{ flex: 1, minWidth: 160 }}
                  />
                  <Tooltip title={tab === "tools" ? "添加 Tool" : "添加 Prompt"}>
                    <Button
                      type="text"
                      icon={<PlusOutlined />}
                      aria-label={tab === "tools" ? "添加 Tool" : "添加 Prompt"}
                      disabled={version?.status !== "DRAFT"}
                      onClick={() => setDialog({ kind: tab === "tools" ? "tool" : "prompt" })}
                    />
                  </Tooltip>
                </Flex>
              </Card>

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

              <Card
                size="small"
                title="资源"
                extra={<Tag>{assets.length}</Tag>}
                styles={{ body: { padding: 8 } }}
              >
                {assets.length === 0 ? (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description={
                      !selectedService
                        ? "从左侧选择一个 MCP 服务"
                        : !version
                          ? "该服务还没有可用版本"
                          : "没有匹配的资源"
                    }
                  />
                ) : (
                  <List
                    size="small"
                    dataSource={assets}
                    rowKey="id"
                    renderItem={(item) => {
                      const current: Asset =
                        tab === "tools"
                          ? { kind: "tool", value: item as McpTool }
                          : { kind: "prompt", value: item as McpPrompt };
                      const selected =
                        asset?.kind === current.kind && asset.value.id === current.value.id;
                      return (
                        <List.Item
                          onClick={() => setAsset(current)}
                          style={{
                            cursor: "pointer",
                            borderRadius: 8,
                            padding: "8px 12px",
                            background: selected ? "var(--studio-selected)" : undefined,
                          }}
                        >
                          <List.Item.Meta
                            avatar={tab === "tools" ? <CodeOutlined /> : <FileTextOutlined />}
                            title={<Typography.Text strong>{item.name}</Typography.Text>}
                            description={
                              item.description ||
                              (tab === "tools" ? "未填写工具说明" : "未填写提示词说明")
                            }
                          />
                          <Typography.Text type="secondary" code style={{ fontSize: 12 }}>
                            {tab === "tools"
                              ? (item as McpTool).handler
                              : `${(item as McpPrompt).arguments.length} 参数`}
                          </Typography.Text>
                        </List.Item>
                      );
                    }}
                  />
                )}
              </Card>
            </Flex>

            <Card
              className="studio-split-layout__detail"
              size="small"
              title="配置与预览"
              style={{ width: 360, flex: "0 0 auto", maxHeight: "100%", overflowY: "auto" }}
            >
              {selectedService && version ? (
                selectedService.type === "REMOTE_MCP" ? (
                  <Alert
                    type="info"
                    showIcon
                    message="远端代理版本无运行限制"
                    description="超时与网络由上游地址配置控制（版本面板 → 上游 MCP 接入）。"
                  />
                ) : (
                  <VersionLimits
                    key={version.id}
                    serviceId={selectedService.id}
                    version={version}
                    onRefresh={refreshSelected}
                  />
                )
              ) : null}
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
                    confirmAction({
                      title: `删除“${asset.value.name}”？`,
                      content: "该资源将从当前版本中移除，该操作不可恢复。",
                      onOk: () =>
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
                          message.success("资源已删除");
                        }),
                    });
                  }}
                />
              ) : (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="选择一个 Tool 或 Prompt，这里会显示参数结构和运行预览。"
                />
              )}
            </Card>
          </Flex>
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
          {dialog?.kind === "environment" ? (
            <EnvironmentDialog
              key={dialog.service.id}
              service={dialog.service}
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
      ) : view === "marketplace" ? (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16 }}>
          <MarketplaceView />
        </div>
      ) : view === "builds" ? (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16 }}>
          <BuildsView />
        </div>
      ) : view === "clients" ? (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16 }}>
          <ClientsView services={services} />
        </div>
      ) : view === "sla" ? (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16 }}>
          <SlaPanel services={services} />
        </div>
      ) : view === "sandbox" ? (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16 }}>
          <DebugSandbox services={services} />
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16 }}>
          <AuditView />
        </div>
      )}
    </StudioPage>
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
  const isRemote = service.type === "REMOTE_MCP";
  const packageRetryable =
    !isRemote && ["DRAFT", "FAILED", "VALIDATING", "BUILDING"].includes(version.status);
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

  const confirmReset = () =>
    confirmAction({
      title: "将该版本重置为草稿？",
      content: "已构建的镜像引用会被清除，该操作不可恢复。",
      onOk: () =>
        void perform("reset", "版本已重置为草稿", async () => {
          const result = await resetVersionToDraft(service.id, version.id, version.revision);
          return result.id;
        }),
    });
  const confirmFork = () =>
    confirmAction({
      title: `从 v${version.versionNumber} 创建新草稿版本？`,
      content: "将在当前版本基础上创建新的草稿版本，原版本不受影响。",
      okText: "创建草稿",
      danger: false,
      onOk: () =>
        void perform("fork", "新草稿版本已创建", async () => {
          const result = await forkDraftVersion(service.id, version.id);
          return result.id;
        }),
    });
  const confirmRollback = () =>
    confirmAction({
      title: `将 ${service.name} 回滚到 v${version.versionNumber}？`,
      content: "Gateway 将切换到该版本，已发布流量会立即变更，请确认。",
      okText: "回滚",
      onOk: () =>
        void perform("rollback", `已回滚到 v${version.versionNumber}`, async () => {
          const result = await rollbackVersion(service.id, version.id, version.revision);
          return result.version.id;
        }),
    });

  return (
    <Card
      size="small"
      title="版本生命周期"
      extra={<Tag color={versionTagColor(version.status)}>{version.status}</Tag>}
    >
      <Flex gap={8} align="center" wrap>
        <Typography.Text type="secondary">版本</Typography.Text>
        <Select
          value={version.id}
          aria-label="版本"
          popupMatchSelectWidth={false}
          onChange={onSelect}
          style={{ minWidth: 200 }}
          options={[...versions]
            .sort((left, right) => right.versionNumber - left.versionNumber)
            .map((item) => ({
              value: item.id,
              label: `v${item.versionNumber} · ${item.status}`,
            }))}
        />
        <Typography.Text type="secondary" code>
          revision {version.revision}
        </Typography.Text>
        <Typography.Text code copyable>
          /mcp/services/{service.slug}
        </Typography.Text>
        {processing ? (
          <Tag icon={<LoadingOutlined spin />} color="warning">
            处理中
          </Tag>
        ) : null}
      </Flex>
      <Flex gap={8} wrap style={{ marginTop: 12 }}>
        {packageRetryable ? (
          <>
            <input
              ref={fileInput}
              hidden
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
            <Tooltip title="上传 ZIP 代码资源包">
              <Button
                size="small"
                loading={busy === "upload"}
                disabled={busy !== null}
                icon={<UploadOutlined />}
                onClick={() => fileInput.current?.click()}
              >
                上传代码包
              </Button>
            </Tooltip>
            <Tooltip
              title={
                buildable
                  ? "构建并检查 Tool 运行镜像"
                  : processing
                    ? "等待当前检查或构建任务完成"
                    : "需要先完成代码包检查"
              }
            >
              <Button
                size="small"
                loading={busy === "build"}
                disabled={busy !== null || !buildable}
                icon={<PlayCircleOutlined />}
                onClick={() =>
                  void perform("build", "镜像构建任务已提交", async () => {
                    const result = await buildVersion(service.id, version.id, version.revision);
                    return result.version.id;
                  })
                }
              >
                构建镜像
              </Button>
            </Tooltip>
          </>
        ) : null}
        {version.status === "DRAFT" && version.tools.length === 0 ? (
          <Button
            size="small"
            loading={busy === "validate"}
            disabled={busy !== null}
            icon={<CheckCircleFilled />}
            onClick={() =>
              void perform(
                "validate",
                isRemote ? "远端上游配置已通过校验" : "Prompt 版本已通过校验",
                async () => {
                  const result = await validateVersion(service.id, version.id, version.revision);
                  return result.id;
                },
              )
            }
          >
            {isRemote ? "校验上游配置" : "校验版本"}
          </Button>
        ) : null}
        {version.status === "READY" ? (
          <>
            <Button
              type="primary"
              size="small"
              loading={busy === "publish"}
              disabled={busy !== null}
              icon={<RocketOutlined />}
              onClick={() =>
                void perform("publish", "版本已发布到 Gateway", async () => {
                  const result = await publishVersion(service.id, version.id, version.revision);
                  return result.version.id;
                })
              }
            >
              发布
            </Button>
            <Tooltip title="重置为草稿">
              <Button
                size="small"
                loading={busy === "reset"}
                disabled={busy !== null}
                icon={<UndoOutlined />}
                aria-label="重置为草稿"
                onClick={confirmReset}
              >
                重置
              </Button>
            </Tooltip>
          </>
        ) : null}
        {version.status === "PUBLISHED" || version.status === "SUPERSEDED" ? (
          <Button
            size="small"
            loading={busy === "fork"}
            disabled={busy !== null}
            icon={<CopyOutlined />}
            onClick={confirmFork}
          >
            创建草稿
          </Button>
        ) : null}
        {service.status === "ACTIVE" &&
        service.currentVersionId !== version.id &&
        (version.status === "READY" || version.status === "SUPERSEDED") ? (
          <Tooltip title={`回滚到 v${version.versionNumber}`}>
            <Button
              size="small"
              loading={busy === "rollback"}
              disabled={busy !== null}
              icon={<UndoOutlined />}
              aria-label={`回滚到 v${version.versionNumber}`}
              onClick={confirmRollback}
            >
              回滚
            </Button>
          </Tooltip>
        ) : null}
      </Flex>
      {isRemote ? (
        <RemoteConfigCard
          service={service}
          version={version}
          onRefresh={(preferredVersionId) => onRefresh(preferredVersionId)}
        />
      ) : (
        <Flex gap={16} wrap style={{ marginTop: 12 }}>
          <Typography.Text type="secondary" title={version.artifactDigest ?? undefined}>
            代码包 {version.artifactSize === null ? "未上传" : formatBytes(version.artifactSize)}
          </Typography.Text>
          <Typography.Text type="secondary" title={version.entry ?? undefined}>
            入口 {version.entry ?? "待检查"}
          </Typography.Text>
          <Typography.Text type="secondary" title={version.imageDigest ?? undefined}>
            镜像 {version.imageDigest ? shortDigest(version.imageDigest) : "未构建"}
          </Typography.Text>
        </Flex>
      )}
      {notice ? (
        <Alert type="success" showIcon message={notice} style={{ marginTop: 12 }} closable />
      ) : null}
      {error ? (
        <Alert type="error" showIcon message={error} role="alert" style={{ marginTop: 12 }} />
      ) : null}
    </Card>
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
    <Flex vertical gap={12}>
      <Flex gap={8} align="center">
        {asset.kind === "tool" ? <CodeOutlined /> : <FileTextOutlined />}
        <Flex vertical gap={0} style={{ flex: 1, minWidth: 0 }}>
          <Typography.Text strong>{asset.value.name}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {asset.value.description || "暂无说明"}
          </Typography.Text>
        </Flex>
        {version.status === "DRAFT" ? (
          <Flex gap={4}>
            <Tooltip title="编辑">
              <Button
                type="text"
                size="small"
                icon={<EditOutlined />}
                aria-label="编辑"
                onClick={onEdit}
              />
            </Tooltip>
            <Tooltip title="删除">
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined />}
                aria-label="删除"
                onClick={onDelete}
              />
            </Tooltip>
          </Flex>
        ) : null}
      </Flex>
      {asset.kind === "tool" ? (
        <>
          <CodeBlock value={JSON.stringify(asset.value.inputSchema, null, 2)} />
          <Form.Item label="Gateway API Key" extra="Bearer" style={{ marginBottom: 0 }}>
            <Input.Password
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="mcp_..."
            />
          </Form.Item>
          {gatewayState ? <Alert type="warning" showIcon message={gatewayState} /> : null}
        </>
      ) : null}
      <Typography.Text strong>输入参数</Typography.Text>
      {properties.length === 0 ? (
        <Typography.Text type="secondary">该资源不需要参数。</Typography.Text>
      ) : null}
      {properties.map(([name, schema]) => (
        <Form.Item
          key={name}
          label={`${name} · ${schema.type ?? "string"}`}
          style={{ marginBottom: 8 }}
        >
          <Input
            value={values[name] ?? ""}
            autoComplete="off"
            onChange={(event) => setValues({ ...values, [name]: event.target.value })}
            placeholder={schema.description ?? "输入测试值"}
          />
        </Form.Item>
      ))}
      <Button
        type="primary"
        block
        loading={busy}
        disabled={asset.kind === "tool" && (!currentGatewayVersion || apiKey.trim().length === 0)}
        onClick={() => void runPreview()}
      >
        {asset.kind === "prompt" ? "渲染 Prompt" : "调用 Tool"}
      </Button>
      {error ? <Alert type="error" showIcon message={error} /> : null}
      {preview ? (
        <Card
          size="small"
          title={
            asset.kind === "tool"
              ? toolResultError
                ? "CallToolResult · 执行错误"
                : "CallToolResult · 执行成功"
              : "预览结果"
          }
        >
          <CodeBlock value={preview} />
        </Card>
      ) : null}
    </Flex>
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
  return (
    <Typography.Paragraph code copyable style={{ whiteSpace: "pre-wrap", marginBottom: 0 }}>
      {value}
    </Typography.Paragraph>
  );
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
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<"MANAGED_MCP" | "REMOTE_MCP">(initial?.type ?? "MANAGED_MCP");
  const [probe, setProbe] = useState<RemoteProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  const submit = async (values: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const value = {
        name: String(values.name ?? "").trim(),
        slug: String(values.slug ?? "").trim(),
      };
      if (initial) {
        await updateService(initial.id, initial.revision, value);
      } else if (kind === "REMOTE_MCP") {
        await createRemoteService({ ...value, remote: collectRemoteInput(values) });
      } else {
        await createService(value);
      }
      await onSaved();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setProbing(true);
    setError(null);
    setProbe(null);
    try {
      const values = (await form.validateFields([
        "transport",
        "url",
        "timeoutMs",
        "headersText",
        "token",
      ])) as Record<string, unknown>;
      setProbe(await testRemoteConnection(collectRemoteInput(values)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setProbing(false);
    }
  };
  return (
    <Dialog title={initial ? "编辑 MCP 服务" : "新建 MCP 服务"} onClose={onClose}>
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          name: initial?.name ?? "",
          slug: initial?.slug ?? "",
          transport: "streamable-http",
          timeoutMs: 30_000,
        }}
        onFinish={(values) => void submit(values as Record<string, unknown>)}
      >
        <Form.Item
          label="服务名称"
          name="name"
          rules={[{ required: true, message: "请输入服务名称" }]}
        >
          <Input autoComplete="off" placeholder="例如：文档分析" />
        </Form.Item>
        <Form.Item
          label="Slug"
          name="slug"
          rules={[
            { required: true, message: "请输入 Slug" },
            { pattern: /^[a-z][a-z0-9-]*$/, message: "Slug 须为小写字母、数字或连字符" },
          ]}
        >
          <Input autoComplete="off" placeholder="document-analysis" />
        </Form.Item>
        {initial ? (
          <Alert
            type="info"
            showIcon
            message={`服务类型：${initial.type === "REMOTE_MCP" ? "远端代理（REMOTE）" : "托管构建（MANAGED）"}，创建后不可更改`}
            style={{ marginBottom: 12 }}
          />
        ) : (
          <Form.Item label="服务类型">
            <Segmented
              value={kind}
              onChange={(value) => setKind(value as "MANAGED_MCP" | "REMOTE_MCP")}
              options={[
                { value: "MANAGED_MCP", label: "托管构建" },
                { value: "REMOTE_MCP", label: "远端代理" },
              ]}
            />
          </Form.Item>
        )}
        {kind === "REMOTE_MCP" && !initial ? (
          <>
            <RemoteFields />
            <Flex gap={8} align="center" wrap style={{ marginBottom: 12 }}>
              <Button size="small" loading={probing} onClick={() => void test()}>
                测试连接
              </Button>
              <Typography.Text type="secondary">
                创建前先验证上游可达；创建后版本自动发布并开始代理。
              </Typography.Text>
            </Flex>
            {probe ? <ProbeResult probe={probe} /> : null}
          </>
        ) : null}
        {error ? (
          <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />
        ) : null}
        <DialogActions busy={busy} onClose={onClose} />
      </Form>
    </Dialog>
  );
}

/** 远端上游接入表单字段（新建服务与编辑版本共用）。 */
function RemoteFields({ initialTokenNote = true }: { initialTokenNote?: boolean }) {
  return (
    <>
      <Form.Item label="传输协议" name="transport" rules={[{ required: true }]}>
        <Select
          options={[
            { value: "streamable-http", label: "Streamable HTTP（推荐）" },
            { value: "sse", label: "SSE（旧版上游）" },
          ]}
        />
      </Form.Item>
      <Form.Item
        label="上游地址"
        name="url"
        rules={[
          { required: true, message: "请输入上游 MCP 地址" },
          { type: "url", message: "须为合法 http(s) 地址" },
        ]}
      >
        <Input autoComplete="off" placeholder="https://mcp.example.com/mcp" />
      </Form.Item>
      <Form.Item
        label="超时（毫秒）"
        name="timeoutMs"
        rules={[{ required: true, message: "请输入超时" }]}
      >
        <InputNumber min={1} max={120_000} step={1000} style={{ width: "100%" }} />
      </Form.Item>
      <Form.Item
        label="自定义请求头（JSON，可选）"
        name="headersText"
        rules={[
          {
            validator: (_, value: unknown) => {
              if (value === undefined || value === null || String(value).trim() === "") {
                return Promise.resolve();
              }
              try {
                parseHeadersJson(String(value));
                return Promise.resolve();
              } catch (reason) {
                return Promise.reject(reason instanceof Error ? reason : new Error(String(reason)));
              }
            },
          },
        ]}
      >
        <Input.TextArea autoComplete="off" rows={2} placeholder='例如：{"x-tenant": "acme"}' />
      </Form.Item>
      <Form.Item
        label={initialTokenNote ? "Token（可选，留空=保留已有）" : "Token（可选）"}
        name="token"
      >
        <Input.Password autoComplete="off" placeholder="上游需要的 Bearer Token" />
      </Form.Item>
    </>
  );
}

/** 解析请求头 JSON：空=undefined；须为 string→string 对象。 */
function parseHeadersJson(text: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("请求头须为合法 JSON 对象");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("请求头须为 JSON 对象");
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string") throw new Error(`请求头 ${key} 的值须为字符串`);
    headers[key] = value;
  }
  return headers;
}

function collectRemoteInput(values: Record<string, unknown>): RemoteServiceConfigInput {
  const headersText = String(values.headersText ?? "").trim();
  const token = String(values.token ?? "");
  return {
    transport: values.transport as RemoteTransport,
    url: String(values.url ?? "").trim(),
    timeoutMs: Number(values.timeoutMs ?? 30_000),
    ...(headersText === "" ? {} : { headers: parseHeadersJson(headersText) }),
    ...(token === "" ? {} : { token }),
  };
}

function ProbeResult({ probe }: { probe: RemoteProbeResult }) {
  return (
    <Alert
      type="success"
      showIcon
      style={{ marginBottom: 12 }}
      message={`上游可达：发现 ${probe.toolCount} 个 Tool（${probe.latencyMs}ms，${probe.transport}）`}
      description={
        probe.tools.length > 0 ? (
          <Typography.Paragraph code copyable style={{ marginBottom: 0, whiteSpace: "pre-wrap" }}>
            {probe.tools
              .slice(0, 10)
              .map((tool) => tool.name)
              .join(", ")}
            {probe.tools.length > 10 ? ` …（共 ${probe.tools.length} 个）` : ""}
          </Typography.Paragraph>
        ) : (
          "上游无可用 Tool"
        )
      }
    />
  );
}

interface EnvironmentRow {
  id: number;
  name: string;
  value: string | null;
  saved: boolean;
}

function EnvironmentDialog({
  service,
  onClose,
  onSaved,
}: {
  service: McpService;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [rows, setRows] = useState<EnvironmentRow[]>([]);
  const [revision, setRevision] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const nextRowId = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setRevision(null);
    getServiceEnvironment(service.id)
      .then((result) => {
        if (cancelled) return;
        setRevision(result.revision);
        setRows(
          Object.keys(result.environment)
            .sort()
            .map((name) => ({ id: nextRowId.current++, name, value: null, saved: true })),
        );
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [service.id, retry]);

  const submitEnv = async () => {
    if (revision === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const entries = rows.map((row) => [row.name.trim(), row.value] as const);
      if (new Set(entries.map(([name]) => name)).size !== entries.length) {
        throw new Error("变量名不能重复");
      }
      const result = await updateServiceEnvironment(
        service.id,
        revision,
        Object.fromEntries(entries),
      );
      setRevision(result.revision);
      setRows((current) => current.map((row) => ({ ...row, value: null, saved: true })));
      await onSaved();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="配置环境变量" onClose={onClose}>
      <Form layout="vertical" onFinish={() => void submitEnv()}>
        <Flex gap={8} align="center" justify="space-between">
          <Typography.Text strong>{service.name}</Typography.Text>
          <Tag>{rows.length} / 64</Tag>
        </Flex>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          服务下的所有 Tool
          共享这些变量，保存后下一次调用生效。已保存的值不会回显，未修改的值会保留。
        </Typography.Paragraph>
        {loading ? <Alert type="info" showIcon message="正在加载环境变量..." /> : null}
        {!loading && revision !== null ? (
          <>
            {rows.map((row, index) => (
              <Card key={row.id} size="small" style={{ marginBottom: 8 }}>
                <Flex gap={8} align="flex-start">
                  <Form.Item
                    label={`变量名 ${index + 1}`}
                    required
                    style={{ flex: 1, marginBottom: 0 }}
                  >
                    <Input
                      disabled={busy || row.saved}
                      aria-label={`变量名 ${index + 1}`}
                      autoComplete="off"
                      spellCheck={false}
                      maxLength={128}
                      placeholder="TAVILY_API_KEY"
                      value={row.name}
                      onChange={(event) =>
                        setRows((current) =>
                          current.map((item) =>
                            item.id === row.id ? { ...item, name: event.target.value } : item,
                          ),
                        )
                      }
                    />
                  </Form.Item>
                  <Form.Item
                    label={`变量值 ${index + 1}${row.value === null ? " · 已保存" : ""}`}
                    style={{ flex: 1, marginBottom: 0 }}
                  >
                    <Input.Password
                      disabled={busy}
                      aria-label={`变量值 ${index + 1}`}
                      autoComplete="new-password"
                      spellCheck={false}
                      maxLength={8192}
                      value={row.value ?? ""}
                      placeholder={row.value === null ? "输入新值替换" : "输入变量值"}
                      onChange={(event) =>
                        setRows((current) =>
                          current.map((item) =>
                            item.id === row.id ? { ...item, value: event.target.value } : item,
                          ),
                        )
                      }
                    />
                  </Form.Item>
                  <Tooltip title="删除变量">
                    <Button
                      type="text"
                      danger
                      size="small"
                      icon={<DeleteOutlined />}
                      aria-label={`删除变量 ${row.name || index + 1}`}
                      disabled={busy}
                      style={{ marginTop: 30 }}
                      onClick={() =>
                        setRows((current) => current.filter((item) => item.id !== row.id))
                      }
                    />
                  </Tooltip>
                </Flex>
              </Card>
            ))}
            {rows.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未配置环境变量" />
            ) : null}
            <Button
              size="small"
              icon={<PlusOutlined />}
              disabled={busy || rows.length >= 64}
              onClick={() =>
                setRows((current) => [
                  ...current,
                  { id: nextRowId.current++, name: "", value: "", saved: false },
                ])
              }
              style={{ marginTop: rows.length ? 8 : 0 }}
            >
              添加变量
            </Button>
          </>
        ) : null}
        {error ? (
          <Alert type="error" showIcon message={error} role="alert" style={{ marginTop: 12 }} />
        ) : null}
        {!loading && revision === null ? (
          <Button
            size="small"
            icon={<ReloadOutlined />}
            onClick={() => setRetry((current) => current + 1)}
            style={{ marginTop: 12 }}
          >
            重新加载
          </Button>
        ) : null}
        <DialogActions busy={busy} disabled={loading || revision === null} onClose={onClose} />
      </Form>
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
  const submitTool = async (values: {
    name: string;
    handler: string;
    description?: string;
    schema: string;
  }) => {
    setBusy(true);
    setError(null);
    try {
      const schema = JSON.parse(String(values.schema)) as Record<string, unknown>;
      const value = {
        name: String(values.name ?? "").trim(),
        handler: String(values.handler ?? "").trim(),
        description: String(values.description ?? "").trim(),
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
      <Form
        layout="vertical"
        initialValues={{
          name: initial?.name ?? "",
          handler: initial?.handler ?? "",
          description: initial?.description ?? "",
          schema: JSON.stringify(
            initial?.inputSchema ?? { type: "object", properties: {}, additionalProperties: false },
            null,
            2,
          ),
        }}
        onFinish={(values) =>
          void submitTool(
            values as { name: string; handler: string; description?: string; schema: string },
          )
        }
      >
        <Flex gap={8}>
          <Form.Item
            label="Tool 名称"
            name="name"
            rules={[{ required: true, message: "请输入 Tool 名称" }]}
            style={{ flex: 1 }}
          >
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item
            label="Handler 导出名"
            name="handler"
            rules={[{ required: true, message: "请输入 Handler" }]}
            style={{ flex: 1 }}
          >
            <Input autoComplete="off" />
          </Form.Item>
        </Flex>
        <Form.Item label="说明" name="description" style={{ marginBottom: 12 }}>
          <Input autoComplete="off" />
        </Form.Item>
        <Form.Item
          label="输入 Schema"
          name="schema"
          rules={[{ required: true, message: "请输入 Schema" }]}
          style={{ marginBottom: 12 }}
        >
          <Input.TextArea autoComplete="off" rows={9} />
        </Form.Item>
        {error ? (
          <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />
        ) : null}
        <DialogActions busy={busy} onClose={onClose} />
      </Form>
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
  const submitPrompt = async (values: {
    name: string;
    title?: string;
    description?: string;
    args: string;
    messages: string;
  }) => {
    setBusy(true);
    setError(null);
    try {
      const value = {
        name: String(values.name ?? "").trim(),
        title: String(values.title ?? "").trim() || undefined,
        description: String(values.description ?? "").trim() || undefined,
        arguments: JSON.parse(String(values.args)) as McpPrompt["arguments"],
        messages: JSON.parse(String(values.messages)) as McpPrompt["messages"],
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
      <Form
        layout="vertical"
        initialValues={{
          name: initial?.name ?? "",
          title: initial?.title ?? "",
          description: initial?.description ?? "",
          args: JSON.stringify(initial?.arguments ?? [{ name: "input", required: true }], null, 2),
          messages: JSON.stringify(
            initial?.messages ?? [{ role: "user", content: { type: "text", text: "{{input}}" } }],
            null,
            2,
          ),
        }}
        onFinish={(values) =>
          void submitPrompt(
            values as {
              name: string;
              title?: string;
              description?: string;
              args: string;
              messages: string;
            },
          )
        }
      >
        <Flex gap={8}>
          <Form.Item
            label="Prompt 名称"
            name="name"
            rules={[{ required: true, message: "请输入 Prompt 名称" }]}
            style={{ flex: 1 }}
          >
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item label="标题" name="title" style={{ flex: 1 }}>
            <Input autoComplete="off" />
          </Form.Item>
        </Flex>
        <Form.Item label="说明" name="description" style={{ marginBottom: 12 }}>
          <Input autoComplete="off" />
        </Form.Item>
        <Form.Item
          label="参数定义"
          name="args"
          rules={[{ required: true, message: "请输入参数定义" }]}
          style={{ marginBottom: 12 }}
        >
          <Input.TextArea autoComplete="off" rows={6} />
        </Form.Item>
        <Form.Item
          label="消息模板"
          name="messages"
          rules={[{ required: true, message: "请输入消息模板" }]}
          style={{ marginBottom: 12 }}
        >
          <Input.TextArea autoComplete="off" rows={9} />
        </Form.Item>
        {error ? (
          <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />
        ) : null}
        <DialogActions busy={busy} onClose={onClose} />
      </Form>
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
    <Modal open centered title={title} onCancel={onClose} footer={null} destroyOnClose>
      {children}
    </Modal>
  );
}

function DialogActions({
  busy,
  disabled = false,
  onClose,
}: {
  busy: boolean;
  disabled?: boolean;
  onClose: () => void;
}) {
  return (
    <Flex gap={8} justify="flex-end" style={{ marginTop: 16 }}>
      <Button onClick={onClose}>取消</Button>
      <Button type="primary" htmlType="submit" loading={busy} disabled={busy || disabled}>
        保存
      </Button>
    </Flex>
  );
}

/** 远端版本的上游接入卡片：展示脱敏配置，支持测试连接与编辑（DRAFT/FAILED/READY）。 */
function RemoteConfigCard({
  service,
  version,
  onRefresh,
}: {
  service: McpService;
  version: McpVersion;
  onRefresh: (preferredVersionId?: string) => Promise<void>;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [probe, setProbe] = useState<RemoteProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editable = ["DRAFT", "FAILED", "READY"].includes(version.status);
  const remote = version.remoteConfig;

  const test = async (override?: RemoteServiceConfigInput) => {
    setProbing(true);
    setBusy(true);
    setError(null);
    setProbe(null);
    try {
      setProbe(await testSavedRemoteConnection(service.id, version.id, override));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setProbing(false);
      setBusy(false);
    }
  };

  if (!remote) {
    return (
      <Alert
        type="warning"
        showIcon
        message="该远端版本尚未配置上游地址，请从已发布版本创建草稿后补齐"
        style={{ marginTop: 12 }}
      />
    );
  }
  return (
    <Card size="small" title="上游 MCP 接入" style={{ marginTop: 12 }}>
      <Descriptions size="small" column={1} bordered>
        <Descriptions.Item label="传输协议">
          <Tag>{remote.transport}</Tag>
        </Descriptions.Item>
        <Descriptions.Item label="上游地址">
          <Typography.Text code copyable>
            {remote.url}
          </Typography.Text>
        </Descriptions.Item>
        <Descriptions.Item label="超时">{remote.timeoutMs} ms</Descriptions.Item>
        <Descriptions.Item label="自定义请求头">
          {remote.headers && Object.keys(remote.headers).length > 0
            ? Object.keys(remote.headers).join(", ")
            : "无"}
        </Descriptions.Item>
        <Descriptions.Item label="Token">
          {remote.hasToken ? <Tag color="success">已保存</Tag> : <Tag>未配置</Tag>}
        </Descriptions.Item>
      </Descriptions>
      <Flex gap={8} wrap style={{ marginTop: 12 }}>
        <Button size="small" loading={probing} disabled={busy} onClick={() => void test()}>
          测试连接
        </Button>
        {editable ? (
          <Button
            size="small"
            disabled={busy}
            icon={<EditOutlined />}
            onClick={() => setDialogOpen(true)}
          >
            编辑上游配置
          </Button>
        ) : (
          <Typography.Text type="secondary">
            已发布版本只读：修改上游需「创建草稿」后再编辑。
          </Typography.Text>
        )}
      </Flex>
      {probe ? (
        <div style={{ marginTop: 12 }}>
          <ProbeResult probe={probe} />
        </div>
      ) : null}
      {error ? (
        <Alert type="error" showIcon message={error} role="alert" style={{ marginTop: 12 }} />
      ) : null}
      {dialogOpen ? (
        <RemoteConfigDialog
          service={service}
          version={version}
          onClose={() => setDialogOpen(false)}
          onSaved={async (preferredVersionId) => {
            setDialogOpen(false);
            await onRefresh(preferredVersionId);
          }}
        />
      ) : null}
    </Card>
  );
}

function RemoteConfigDialog({
  service,
  version,
  onClose,
  onSaved,
}: {
  service: McpService;
  version: McpVersion;
  onClose: () => void;
  onSaved: (preferredVersionId?: string) => Promise<void>;
}) {
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<RemoteProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [clearToken, setClearToken] = useState(false);
  const remote = version.remoteConfig;

  const collectPatch = (values: Record<string, unknown>): Partial<RemoteServiceConfigInput> => {
    const input = collectRemoteInput(values);
    const patch: Partial<RemoteServiceConfigInput> & { headersText?: unknown } = { ...input };
    if (clearToken) patch.token = "";
    return patch;
  };

  const submit = async (values: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await updateRemoteConfig(
        service.id,
        version.id,
        version.revision,
        collectPatch(values),
      );
      await onSaved(result.id);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setProbing(true);
    setError(null);
    setProbe(null);
    try {
      const values = (await form.validateFields([
        "transport",
        "url",
        "timeoutMs",
        "headersText",
        "token",
      ])) as Record<string, unknown>;
      // 表单 token 为空=保留已有：服务端会自动用已保存 token 补齐后探测。
      setProbe(await testSavedRemoteConnection(service.id, version.id, collectRemoteInput(values)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setProbing(false);
    }
  };

  return (
    <Dialog title={`编辑上游配置 · v${version.versionNumber}`} onClose={onClose}>
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          transport: remote?.transport ?? "streamable-http",
          url: remote?.url ?? "",
          timeoutMs: remote?.timeoutMs ?? 30_000,
        }}
        onFinish={(values) => void submit(values as Record<string, unknown>)}
      >
        <RemoteFields />
        <Form.Item style={{ marginBottom: 0 }}>
          <Flex gap={16} align="center">
            <Typography.Text type="secondary">
              Token 留空=保留已有{remote?.hasToken ? "（已保存）" : "（未保存）"}。
            </Typography.Text>
            {remote?.hasToken ? (
              <label>
                <input
                  type="checkbox"
                  checked={clearToken}
                  onChange={(event) => setClearToken(event.target.checked)}
                />{" "}
                清除已保存 Token
              </label>
            ) : null}
          </Flex>
        </Form.Item>
        <Flex gap={8} align="center" wrap style={{ marginTop: 12, marginBottom: 12 }}>
          <Button size="small" loading={probing} onClick={() => void test()}>
            测试连接
          </Button>
          <Typography.Text type="secondary">
            保存后版本 revision +1，需重新校验/发布。
          </Typography.Text>
        </Flex>
        {probe ? <ProbeResult probe={probe} /> : null}
        {error ? (
          <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />
        ) : null}
        <DialogActions busy={busy} onClose={onClose} />
      </Form>
    </Dialog>
  );
}
