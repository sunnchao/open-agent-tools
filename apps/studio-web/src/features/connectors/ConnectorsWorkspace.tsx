import { useCallback, useEffect, useState } from "react";
import {
  App,
  Badge,
  Button,
  Card,
  Empty,
  Flex,
  Form,
  Input,
  List,
  Popconfirm,
  Select,
  Spin,
  Switch,
  Table,
  Tag,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  BranchesOutlined,
  DeleteOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
  SyncOutlined,
} from "../../lib/icons.js";
import { StudioPage } from "../../components/studio/StudioPageHeader.js";
import { StudioNotice, type StudioNoticeValue } from "../../components/studio/StudioNotice.js";
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
import { errorMessage as errorText } from "@open-agent-tools/api-contracts/values";

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

type Notice = StudioNoticeValue;

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

function connectorBadge(
  status: ConnectorRecord["lastStatus"],
): "success" | "processing" | "error" | "default" {
  if (status === "success") return "success";
  if (status === "partial") return "processing";
  if (status === "error") return "error";
  return "default";
}

function runTagColor(status: ConnectorSyncRun["status"]): string {
  if (status === "success") return "success";
  if (status === "partial") return "warning";
  if (status === "error") return "error";
  return "default";
}

export function ConnectorsWorkspace() {
  const { message } = App.useApp();
  const [connectors, setConnectors] = useState<ConnectorRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runs, setRuns] = useState<ConnectorSyncRun[]>([]);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [loadingList, setLoadingList] = useState(true);

  const selected = connectors.find((item) => item.id === selectedId) ?? null;

  const refresh = useCallback(async () => {
    try {
      const list = await fetchConnectors();
      setConnectors(list);
      return list;
    } catch (error) {
      setNotice({ type: "error", text: errorText(error) });
      return [];
    } finally {
      setLoadingList(false);
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
      void message.success(`已保存连接器「${saved.name}」`);
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
      const text = runSummary(result.run);
      if (result.run.status === "error") {
        setNotice({ type: "error", text });
      } else {
        void message.success(text);
        setNotice({ type: "success", text });
      }
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
      void message.success("连接器已删除");
      setNotice({ type: "success", text: "连接器已删除" });
    } catch (error) {
      setNotice({ type: "error", text: errorText(error) });
    } finally {
      setBusy(null);
    }
  };

  const credentialFields = CONNECTOR_CREDENTIAL_FIELDS[form.type];

  const runColumns: ColumnsType<ConnectorSyncRun> = [
    {
      title: "时间",
      dataIndex: "startedAt",
      key: "startedAt",
      render: (value: string) => (
        <Typography.Text type="secondary">{new Date(value).toLocaleString()}</Typography.Text>
      ),
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      render: (value: ConnectorSyncRun["status"]) => (
        <Tag color={runTagColor(value)}>{statusLabel(value)}</Tag>
      ),
    },
    { title: "拉取", dataIndex: "pulled", key: "pulled" },
    { title: "入库", dataIndex: "ingested", key: "ingested" },
    { title: "跳过", dataIndex: "skipped", key: "skipped" },
    { title: "失败", dataIndex: "failed", key: "failed" },
    {
      title: "说明",
      dataIndex: "id",
      key: "note",
      ellipsis: true,
      render: (_: unknown, record: ConnectorSyncRun) => (
        <Typography.Text type="secondary" ellipsis title={runNote(record)}>
          {runNote(record)}
        </Typography.Text>
      ),
    },
  ];

  return (
    <StudioPage
      eyebrow="Knowledge Connectors / A6"
      title="文档连接器"
      description="配置外部知识源与同步规则,同步结果自动进入知识库。"
      actions={
        <>
          <Button icon={<PlusOutlined />} type="primary" onClick={startCreate}>
            新建
          </Button>
          <Button icon={<ReloadOutlined />} disabled={busy !== null} onClick={() => void refresh()}>
            刷新
          </Button>
        </>
      }
      extra={<StudioNotice notice={notice} />}
    >
      <Flex
        className="studio-split-layout"
        gap={12}
        align="flex-start"
        style={{ flex: 1, minHeight: 0, padding: 16, overflow: "hidden" }}
      >
        <Card
          className="studio-split-layout__aside"
          size="small"
          title="连接器"
          extra={<Tag>{connectors.length}</Tag>}
          style={{ width: 280, flex: "0 0 auto", maxHeight: "100%", overflow: "hidden" }}
          styles={{ body: { padding: 8, overflowY: "auto", maxHeight: "calc(100% - 57px)" } }}
        >
          {loadingList ? (
            <Flex justify="center" style={{ padding: 24 }}>
              <Spin aria-label="正在加载连接器" />
            </Flex>
          ) : connectors.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="还没有连接器,点击「新建」配置一个知识源。"
            />
          ) : (
            <List
              size="small"
              dataSource={connectors}
              rowKey="id"
              renderItem={(record) => (
                <List.Item
                  onClick={() => selectConnector(record)}
                  style={{
                    cursor: "pointer",
                    borderRadius: 8,
                    padding: "8px 10px",
                    background: record.id === selectedId ? "var(--studio-selected)" : undefined,
                  }}
                >
                  <List.Item.Meta
                    avatar={<Badge status={connectorBadge(record.lastStatus)} />}
                    title={
                      <Flex gap={8} align="center">
                        <Typography.Text strong ellipsis style={{ maxWidth: 140 }}>
                          {record.name}
                        </Typography.Text>
                        {record.enabled ? null : <Tag>已停用</Tag>}
                      </Flex>
                    }
                    description={CONNECTOR_TYPE_LABELS[record.type]}
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
          <Card
            size="small"
            title={
              <Flex gap={8} align="center">
                <BranchesOutlined />
                <Typography.Text strong>{form.id ? "编辑连接器" : "新建连接器"}</Typography.Text>
              </Flex>
            }
            extra={
              selected ? (
                <Typography.Text type="secondary">
                  最近同步:{" "}
                  {selected.lastSyncedAt ? new Date(selected.lastSyncedAt).toLocaleString() : "—"} ·{" "}
                  {statusLabel(selected.lastStatus)}
                </Typography.Text>
              ) : undefined
            }
          >
            <Form layout="vertical">
              <Form.Item label="名称" required>
                <Input
                  aria-label="连接器名称"
                  value={form.name}
                  placeholder="例如:HR 知识库"
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                />
              </Form.Item>
              <Form.Item label="类型" help={CONNECTOR_BASE_URL_HINTS[form.type]}>
                <Select
                  aria-label="连接器类型"
                  value={form.type}
                  onChange={(value) => setForm({ ...form, type: value, credentials: {} })}
                  options={CONNECTOR_TYPES.map((type) => ({
                    value: type,
                    label: CONNECTOR_TYPE_LABELS[type],
                  }))}
                />
              </Form.Item>
              <Form.Item label="Base URL / 路径">
                <Input
                  aria-label="Base URL 或路径"
                  value={form.baseUrl}
                  placeholder={CONNECTOR_BASE_URL_HINTS[form.type]}
                  onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
                />
              </Form.Item>
              {credentialFields.map((field) => (
                <Form.Item
                  key={field.key}
                  label={field.label}
                  help={
                    form.id && selected?.credentialKeys.includes(field.key)
                      ? "已配置,留空保持不变"
                      : undefined
                  }
                >
                  {field.secret ? (
                    <Input.Password
                      aria-label={field.label}
                      value={form.credentials[field.key] ?? ""}
                      placeholder={field.placeholder}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          credentials: { ...form.credentials, [field.key]: event.target.value },
                        })
                      }
                    />
                  ) : (
                    <Input
                      aria-label={field.label}
                      value={form.credentials[field.key] ?? ""}
                      placeholder={field.placeholder}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          credentials: { ...form.credentials, [field.key]: event.target.value },
                        })
                      }
                    />
                  )}
                </Form.Item>
              ))}
              <Form.Item label="包含规则" help="每行一条,支持 * 通配">
                <Input.TextArea
                  aria-label="包含规则"
                  rows={3}
                  value={form.includeText}
                  placeholder={"hr/*\n*.md"}
                  onChange={(event) => setForm({ ...form, includeText: event.target.value })}
                />
              </Form.Item>
              <Form.Item label="排除规则" help="每行一条">
                <Input.TextArea
                  aria-label="排除规则"
                  rows={3}
                  value={form.excludeText}
                  placeholder="*draft*"
                  onChange={(event) => setForm({ ...form, excludeText: event.target.value })}
                />
              </Form.Item>
              <Form.Item label="单次最大文档数" help="留空表示不限">
                <Input
                  aria-label="单次最大文档数"
                  value={form.maxDocuments}
                  inputMode="numeric"
                  placeholder="留空表示不限"
                  onChange={(event) => setForm({ ...form, maxDocuments: event.target.value })}
                />
              </Form.Item>
              <Form.Item label="启用该连接器">
                <Switch
                  aria-label="启用该连接器"
                  checked={form.enabled}
                  onChange={(checked) => setForm({ ...form, enabled: checked })}
                />
              </Form.Item>
              <Flex gap={8} justify="flex-end" wrap>
                <Button
                  type="primary"
                  icon={<SaveOutlined />}
                  loading={busy === "save"}
                  disabled={busy !== null && busy !== "save"}
                  onClick={() => void save()}
                >
                  保存
                </Button>
                <Button
                  icon={<SyncOutlined />}
                  loading={busy === "sync"}
                  disabled={!selected || busy !== null}
                  onClick={() => void runSync()}
                >
                  立即同步
                </Button>
                <Popconfirm
                  title="删除这个连接器?"
                  description="配置与同步记录将一并清理,该操作不可恢复。"
                  okText="确认删除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => void remove()}
                >
                  <Button
                    danger
                    icon={<DeleteOutlined />}
                    disabled={!selected || busy !== null}
                    aria-label="删除连接器"
                  >
                    删除
                  </Button>
                </Popconfirm>
              </Flex>
            </Form>
          </Card>

          <Card size="small" title="最近同步结果" extra={<Tag>{runs.length}</Tag>}>
            <Table<ConnectorSyncRun>
              size="small"
              rowKey="id"
              columns={runColumns}
              dataSource={runs}
              pagination={runs.length > 10 ? { pageSize: 10, showSizeChanger: false } : false}
              scroll={{ x: "max-content" }}
              locale={{
                emptyText: <Empty description="尚无同步记录,点击「立即同步」试运行一次。" />,
              }}
            />
          </Card>
        </Flex>
      </Flex>
    </StudioPage>
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
