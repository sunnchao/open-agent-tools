import { useEffect, useState } from "react";
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
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
import { StudioNotice, type StudioNoticeValue } from "../../components/studio/StudioNotice.js";
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

function syncBadge(source: SchemaSourceMetadata): { status: "success" | "processing" | "error" | "default"; text: string } {
  if (!source.enabled) return { status: "default", text: "已停用" };
  if (source.syncStatus === "ready") return { status: "success", text: "已同步" };
  if (source.syncStatus === "syncing") return { status: "processing", text: "同步中" };
  if (source.syncStatus === "error") return { status: "error", text: "同步失败" };
  return { status: "default", text: "待同步" };
}

export function SchemaSourcesSection() {
  const { message } = App.useApp();
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
  const [notice, setNotice] = useState<StudioNoticeValue | null>(null);

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
    setNotice(null);
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
      const text = "Schema 源已保存；首次打开时会采集目录并构建关系图。";
      setNotice({ type: "success", text });
      void message.success("Schema 源已保存");
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
      setNotice({ type: "success", text: `已将「${source.name}」设为默认源` });
      void message.success(`已将「${source.name}」设为默认源`);
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
      const text = `连接成功：${result.database} · ${connectorLabel(source.connector)} ${result.version}`;
      setNotice({ type: "success", text });
      void message.success(text);
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
      const text = `${source.name} 已同步：${synced.tableCount} 张表 · ${synced.relationCount} 条关系`;
      setNotice({ type: "success", text });
      void message.success(text);
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
      const text = `已创建“${source.name}”副本；副本默认停用，请编辑确认后再启用。`;
      setNotice({ type: "success", text });
      void message.success("已创建副本");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "复制数据源失败");
    } finally {
      setDuplicatingId(null);
    }
  };

  const remove = async (source: SchemaSourceMetadata) => {
    setError(null);
    try {
      await removeSchemaSource(source.id);
      await refresh();
      setNotice({ type: "success", text: `Schema 源“${source.name}”已删除` });
      void message.success(`Schema 源“${source.name}”已删除`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除失败");
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

  const columns: ColumnsType<SchemaSourceMetadata> = [
    {
      title: "名称",
      dataIndex: "name",
      key: "name",
      render: (_: unknown, record: SchemaSourceMetadata) => (
        <Flex gap={8} align="center">
          <Badge status={record.enabled ? "success" : "default"} />
          <Typography.Text strong>{record.name}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.managedByEnv ? "ENV MANAGED" : record.id}
          </Typography.Text>
        </Flex>
      ),
    },
    {
      title: "连接器",
      dataIndex: "connector",
      key: "connector",
      render: (value: SchemaSourceConnector) => <Tag>{connectorLabel(value)}</Tag>,
    },
    {
      title: "端点",
      dataIndex: "endpoint",
      key: "endpoint",
      render: (value: string) => (
        <Typography.Text code ellipsis style={{ maxWidth: 200 }} title={value}>
          {value}
        </Typography.Text>
      ),
    },
    {
      title: "采集范围",
      dataIndex: "tableFilter",
      key: "tableFilter",
      render: (value: string[]) => (
        <Typography.Text type="secondary" ellipsis style={{ maxWidth: 180 }} title={value.join(", ")}>
          {value.length > 0 ? value.join(", ") : "全部业务表"}
        </Typography.Text>
      ),
    },
    {
      title: "语义模板",
      dataIndex: "semanticProfile",
      key: "semanticProfile",
      render: (value: string) => <Tag>{value === "oneapi" ? "oneapi" : "通用"}</Tag>,
    },
    {
      title: "状态",
      dataIndex: "syncStatus",
      key: "syncStatus",
      render: (_: unknown, record: SchemaSourceMetadata) => {
        const badge = syncBadge(record);
        return (
          <Flex vertical gap={2}>
            <Badge status={badge.status} text={badge.text} />
            {record.syncStatus === "ready" ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }} title={record.lastSyncedAt ?? undefined}>
                {record.tableCount} 表 · {record.relationCount} 关系
                {record.lastSyncedAt ? ` · ${formatSyncTime(record.lastSyncedAt)}` : ""}
              </Typography.Text>
            ) : record.lastError ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis title={record.lastError}>
                {record.lastError}
              </Typography.Text>
            ) : null}
          </Flex>
        );
      },
    },
    {
      title: "默认",
      dataIndex: "isDefault",
      key: "isDefault",
      render: (_: unknown, record: SchemaSourceMetadata) =>
        record.isDefault ? (
          <Tag>DEFAULT</Tag>
        ) : (
          <Button
            type="text"
            size="small"
            icon={<StarOutlined spin={defaultingId === record.id} />}
            disabled={!record.enabled || defaultingId !== null}
            onClick={() => void makeDefault(record)}
            aria-label={`设 ${record.name} 为默认`}
          >
            {defaultingId === record.id ? "设置中" : "设为默认"}
          </Button>
        ),
    },
    {
      title: "操作",
      key: "actions",
      fixed: "right",
      width: 200,
      render: (_: unknown, record: SchemaSourceMetadata) => (
        <Flex gap={4}>
          <Tooltip title="预览 Schema">
            <Button
              type="text"
              icon={<EyeOutlined spin={previewingId === record.id} />}
              aria-label={`预览 ${record.name} Schema`}
              disabled={!record.enabled || previewingId !== null}
              onClick={() => void openPreview(record)}
            />
          </Tooltip>
          <Tooltip title="同步 Schema">
            <Button
              type="text"
              icon={<SyncOutlined spin={syncingId === record.id} />}
              aria-label={`同步 ${record.name} Schema`}
              disabled={!record.enabled || syncingId !== null}
              onClick={() => void synchronize(record)}
            />
          </Tooltip>
          <Tooltip title="复制配置">
            <Button
              type="text"
              icon={<CopyOutlined spin={duplicatingId === record.id} />}
              aria-label={`复制 ${record.name}`}
              disabled={duplicatingId !== null}
              onClick={() => void duplicate(record)}
            />
          </Tooltip>
          <Tooltip title="测试连接">
            <Button
              type="text"
              icon={<DatabaseOutlined spin={testingId === record.id} />}
              aria-label={`测试 ${record.name} 连接`}
              disabled={testingId !== null}
              onClick={() => void probeExisting(record)}
            />
          </Tooltip>
          {!record.managedByEnv ? (
            <Tooltip title="编辑">
              <Button
                type="text"
                icon={<EditOutlined />}
                aria-label={`编辑 ${record.name}`}
                onClick={() => edit(record)}
              />
            </Tooltip>
          ) : null}
          {!record.managedByEnv && !record.isDefault ? (
            <Popconfirm
              title={`删除 Schema 源“${record.name}”？`}
              description="配置与采集记录将清理，该操作不可恢复。"
              okText="确认删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => void remove(record)}
            >
              <Tooltip title="删除">
                <Button
                  type="text"
                  danger
                  icon={<DeleteOutlined />}
                  aria-label={`删除 ${record.name}`}
                />
              </Tooltip>
            </Popconfirm>
          ) : null}
        </Flex>
      ),
    },
  ];

  return (
    <Flex vertical gap={12}>
      {error ? <Alert type="error" showIcon message={error} /> : null}
      <StudioNotice notice={notice} />
      <Flex align="flex-start" justify="space-between" gap={12}>
        <Flex vertical gap={2}>
          <Typography.Text type="secondary" style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2 }}>
            SCHEMA ROUTING
          </Typography.Text>
          <Typography.Title level={5} style={{ margin: 0 }}>
            数据源目录 <Tag style={{ marginLeft: 8 }}>{sources.length}</Tag>
          </Typography.Title>
        </Flex>
        <Flex gap={8}>
          <Button icon={<ReloadOutlined spin={loading} />} disabled={loading} onClick={() => void refresh()}>
            刷新
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setError(null);
              setNotice(null);
              setDraft(emptyDraft());
            }}
          >
            新建数据源
          </Button>
        </Flex>
      </Flex>
      <Card size="small" styles={{ body: { padding: 0 } }}>
        <Table<SchemaSourceMetadata>
          size="small"
          rowKey="id"
          columns={columns}
          dataSource={sources}
          loading={loading}
          pagination={sources.length > 10 ? { pageSize: 10, showSizeChanger: false } : false}
          scroll={{ x: "max-content" }}
          locale={{
            emptyText: (
              <Empty description={loading ? "正在加载 Schema 源..." : "还没有 Schema 源，请先添加只读数据库连接。"} />
            ),
          }}
        />
      </Card>
      <SchemaSourceModal
        draft={draft}
        setDraft={setDraft}
        saving={saving}
        error={error}
        onCancel={() => setDraft(null)}
        onSubmit={(input) => void submit(input)}
      />
      <SchemaCatalogModal preview={preview} onClose={() => setPreview(null)} />
    </Flex>
  );
}

function SchemaCatalogModal({
  preview,
  onClose,
}: {
  preview: SchemaCatalogPreview | null;
  onClose: () => void;
}) {
  if (!preview) return null;
  return (
    <Modal
      centered
      open
      title={preview.database}
      onCancel={onClose}
      footer={
        <Button type="primary" onClick={onClose}>
          完成
        </Button>
      }
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        {preview.tables.length} 张表 · {preview.relationCount} 条关系 ·{" "}
        {new Date(preview.collectedAt).toLocaleString()}
      </Typography.Paragraph>
      <List
        size="small"
        dataSource={preview.tables}
        rowKey="name"
        renderItem={(table) => (
          <List.Item
            extra={
              <Flex gap={8}>
                <Tag>{table.columnCount} 列</Tag>
                <Tag>~{table.rows} 行</Tag>
              </Flex>
            }
          >
            <List.Item.Meta
              title={<Typography.Text strong>{table.name}</Typography.Text>}
              description={table.comment || "无表注释"}
            />
          </List.Item>
        )}
        locale={{ emptyText: <Empty description="暂无表" /> }}
      />
    </Modal>
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
  draft: SchemaSourceDraft | null;
  setDraft: (draft: SchemaSourceDraft) => void;
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (input: SchemaSourceDraft) => void;
}) {
  const [filterText, setFilterText] = useState(draft?.tableFilter.join(", ") ?? "");
  const [connectionMode, setConnectionMode] = useState<"fields" | "url">("fields");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ type: "ok" | "error"; text: string } | null>(null);
  if (!draft) return null;
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
    <Modal
      centered
      open
      title={draft.id ? "编辑数据源" : "新建数据源"}
      onCancel={onCancel}
      width={640}
      footer={
        <Flex justify="space-between" align="center" gap={8} wrap>
          <Button
            icon={<DatabaseOutlined spin={testing} />}
            disabled={saving || testing || !validConnection}
            onClick={() => void testConnection()}
          >
            {testing ? "测试中" : "测试连接"}
          </Button>
          <Flex gap={8}>
            <Button onClick={onCancel}>取消</Button>
            <Button
              type="primary"
              icon={<SaveOutlined />}
              loading={saving}
              disabled={saving || testing || !canSubmit}
              onClick={() => {
                if (canSubmit && !saving && !testing) onSubmit(input);
              }}
            >
              {saving ? "保存中" : "保存数据源"}
            </Button>
          </Flex>
        </Flex>
      }
    >
      <Form layout="vertical" preserve={false}>
        <Form.Item label="名称" required>
          <Input
            aria-label="数据源名称"
            value={draft.name}
            onChange={(event) => patch({ name: event.target.value })}
            placeholder="例如 生产运营库"
          />
        </Form.Item>
        <Form.Item label="数据库类型">
          <Select
            aria-label="数据库类型"
            value={draft.connector}
            onChange={(value) => changeConnector(value as SchemaSourceConnector)}
            options={[
              { value: "mysql", label: "MySQL" },
              { value: "postgresql", label: "PostgreSQL" },
            ]}
          />
        </Form.Item>
        <Form.Item label="连接配置">
          <Segmented<"fields" | "url">
            aria-label="连接配置方式"
            value={connectionMode}
            onChange={(value) => {
              setConnectionMode(value);
              setTestResult(null);
            }}
            options={[
              { value: "fields", label: "分项填写" },
              { value: "url", label: "连接串" },
            ]}
          />
        </Form.Item>
        {connectionMode === "fields" ? (
          <>
            <Form.Item label="IP / 主机名" required>
              <Input
                aria-label="IP / 主机名"
                value={draft.host ?? ""}
                onChange={(event) => patch({ host: event.target.value })}
                placeholder="192.168.1.10 或 db.example.com"
                autoComplete="off"
              />
            </Form.Item>
            <Form.Item label="端口" required>
              <InputNumber
                aria-label="端口"
                min={1}
                max={65535}
                precision={0}
                value={draft.port}
                onChange={(value) => patch({ port: value == null ? undefined : Number(value) })}
                placeholder={draft.connector === "postgresql" ? "5432" : "3306"}
                style={{ width: "100%" }}
              />
            </Form.Item>
            <Form.Item label="账户" extra="建议使用只读账号">
              <Input
                aria-label="账户"
                value={draft.username ?? ""}
                onChange={(event) => patch({ username: event.target.value })}
                placeholder="readonly"
                autoComplete="off"
              />
            </Form.Item>
            <Form.Item label="密码" extra={draft.id ? "留空保持原密码" : "无密码时可留空"}>
              <Input.Password
                aria-label="密码"
                value={draft.password ?? ""}
                onChange={(event) => patch({ password: event.target.value })}
                placeholder={draft.id ? "已保存的密码" : "请输入密码"}
                autoComplete="new-password"
              />
            </Form.Item>
          </>
        ) : (
          <Form.Item label="连接串" extra={draft.id ? "留空保持原连接" : "支持附加连接参数"}>
            <Input.Password
              aria-label="连接串"
              value={draft.connectionString ?? ""}
              onChange={(event) => patch({ connectionString: event.target.value })}
              placeholder={connectionPlaceholder(draft.connector)}
              autoComplete="new-password"
            />
          </Form.Item>
        )}
        <Form.Item label="数据库名称" extra={connectionMode === "url" ? "可覆盖连接串中的库名" : undefined} required={connectionMode === "fields"}>
          <Input
            aria-label="数据库名称"
            value={draft.databaseName}
            onChange={(event) => patch({ databaseName: event.target.value })}
            placeholder={connectionMode === "fields" ? "例如 analytics" : "可选"}
          />
        </Form.Item>
        {draft.connector === "postgresql" ? (
          <Form.Item label="Schema" extra="默认 public">
            <Input
              aria-label="Schema"
              value={draft.schemaName}
              onChange={(event) => patch({ schemaName: event.target.value })}
              placeholder="public"
            />
          </Form.Item>
        ) : null}
        <Form.Item label="语义模板">
          <Select
            aria-label="语义模板"
            value={draft.semanticProfile}
            onChange={(value) =>
              patch({ semanticProfile: value as SchemaSourceDraft["semanticProfile"] })
            }
            options={[
              { value: "generic", label: "通用 Schema" },
              { value: "oneapi", label: "oneapi 运营库" },
            ]}
          />
        </Form.Item>
        <Form.Item label="表范围" extra="逗号分隔，支持 * 通配符；留空采集全部业务表">
          <Input.TextArea
            aria-label="表范围"
            value={filterText}
            onChange={(event) => changeFilters(event.target.value)}
            placeholder="users, orders, report_*"
            rows={3}
          />
        </Form.Item>
        <Form.Item label="启用数据源" extra="停用后不会出现在问数选择器">
          <Switch
            aria-label="启用数据源"
            checked={draft.enabled}
            onChange={(checked) => patch({ enabled: checked })}
          />
        </Form.Item>
        {testResult ? (
          <Alert type={testResult.type === "ok" ? "success" : "error"} showIcon message={testResult.text} style={{ marginBottom: 12 }} />
        ) : null}
        {error ? <Alert type="error" showIcon message={error} /> : null}
      </Form>
    </Modal>
  );
}
