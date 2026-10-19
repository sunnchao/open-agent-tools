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
  Modal,
  Popconfirm,
  Select,
  Table,
  Tag,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { CopyOutlined, DeleteOutlined, PlusOutlined, ReloadOutlined } from "../../lib/icons.js";
import { useResourceCatalog } from "../resources/useResourceCatalog.js";
import {
  createPublishedApp,
  deletePublishedApp,
  employeeEntryPath,
  fetchPublishedAppIdentity,
  fetchPublishedApps,
  rotateAccessToken,
  updatePublishedApp,
  type PublishedAppRecord,
  type PublishedAppResources,
  type PublishedAppIdentity,
} from "./adminApi.js";

/**
 * 发布态管理：把「知识库 + 工具 + 提示词」打包成员工可用入口。
 *
 * 只暴露发布所需的最少配置（名称、欢迎语、示例问题、资源绑定），
 * 让管理员能在 3 步内交付一个可用的员工入口，而不是去配 Provider 与协议。
 */
export function PublishedAppsSection() {
  const { message } = App.useApp();
  const [apps, setApps] = useState<PublishedAppRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [welcome, setWelcome] = useState("");
  const [ragSources, setRagSources] = useState<string[]>([]);
  const [sqlSources, setSqlSources] = useState<string[]>([]);
  const [allowedGroupsText, setAllowedGroupsText] = useState("");
  const [busy, setBusy] = useState(false);
  const [quotaBusy, setQuotaBusy] = useState(false);
  const [identity, setIdentity] = useState<PublishedAppIdentity | null>(null);
  // 刚生成的口令：只在内存里保留到刷新，用于展示与复制。
  const [freshTokens, setFreshTokens] = useState<Record<string, string>>({});
  const [quotaApp, setQuotaApp] = useState<PublishedAppRecord | null>(null);
  const [quotaForm] = Form.useForm();
  const catalog = useResourceCatalog();

  const parseGroups = (value: string): string[] =>
    value
      .split(/[,，\n]/)
      .map((group) => group.trim())
      .filter((group, index, all) => Boolean(group) && all.indexOf(group) === index)
      .slice(0, 50);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextApps, nextIdentity] = await Promise.all([
        fetchPublishedApps(),
        fetchPublishedAppIdentity(),
      ]);
      setApps(nextApps);
      setIdentity(nextIdentity);
    } catch (reason) {
      const text = reason instanceof Error ? reason.message : "发布应用加载失败";
      setError(text);
      void message.error(text);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const resources: PublishedAppResources = {};
      if (ragSources.length > 0) resources.rag = { sources: ragSources, topK: 5 };
      if (sqlSources.length > 0) resources.sqlSources = sqlSources;
      await createPublishedApp({
        name: name.trim(),
        welcome: welcome.trim(),
        resources,
        allowedGroups: parseGroups(allowedGroupsText),
        suggestions: [],
      });
      setName("");
      setWelcome("");
      setRagSources([]);
      setSqlSources([]);
      setAllowedGroupsText("");
      await refresh();
      void message.success("应用已发布");
    } catch (reason) {
      const text = reason instanceof Error ? reason.message : "创建失败";
      setError(text);
      void message.error(text);
    } finally {
      setBusy(false);
    }
  };

  const toggleStatus = async (app: PublishedAppRecord) => {
    try {
      await updatePublishedApp(app.id, {
        status: app.status === "ACTIVE" ? "ARCHIVED" : "ACTIVE",
      });
      await refresh();
      void message.success(app.status === "ACTIVE" ? "应用已下线" : "应用已上线");
    } catch (reason) {
      const text = reason instanceof Error ? reason.message : "状态更新失败";
      setError(text);
      void message.error(text);
    }
  };

  const remove = async (app: PublishedAppRecord) => {
    try {
      await deletePublishedApp(app.id);
      await refresh();
      void message.success("发布应用已删除");
    } catch (reason) {
      const text = reason instanceof Error ? reason.message : "删除失败";
      setError(text);
      void message.error(text);
    }
  };

  const entryUrl = (app: PublishedAppRecord) =>
    `${window.location.origin}${window.location.pathname}${employeeEntryPath(
      app.slug,
      freshTokens[app.id] ?? null,
    )}`;

  const toggleAccess = async (app: PublishedAppRecord) => {
    const enable = app.accessMode !== "token";
    try {
      const result = await rotateAccessToken(app.id, enable);
      if (result.token) {
        setFreshTokens((prev) => ({ ...prev, [app.id]: result.token as string }));
      } else {
        setFreshTokens((prev) => {
          const next = { ...prev };
          delete next[app.id];
          return next;
        });
      }
      await refresh();
      void message.success(enable ? "访问口令已生成" : "访问口令已撤销");
    } catch (reason) {
      const text = reason instanceof Error ? reason.message : "口令操作失败";
      setError(text);
      void message.error(text);
    }
  };

  const saveQuota = async (
    app: PublishedAppRecord,
    patch: { rateLimitPerMinute?: number; dailyTokenBudget?: number },
  ) => {
    try {
      await updatePublishedApp(app.id, patch);
      await refresh();
      void message.success("配额已保存");
    } catch (reason) {
      const text = reason instanceof Error ? reason.message : "配额保存失败";
      setError(text);
      void message.error(text);
    }
  };

  const openQuota = (app: PublishedAppRecord) => {
    setQuotaApp(app);
    quotaForm.setFieldsValue({
      rateLimitPerMinute: app.rateLimitPerMinute,
      dailyTokenBudget: app.dailyTokenBudget,
    });
  };

  const submitQuota = async () => {
    if (!quotaApp) return;
    try {
      const values = await quotaForm.validateFields();
      setQuotaBusy(true);
      await saveQuota(quotaApp, {
        rateLimitPerMinute: Number(values.rateLimitPerMinute),
        dailyTokenBudget: Number(values.dailyTokenBudget),
      });
      setQuotaApp(null);
    } catch {
      // 表单校验失败时保持弹窗打开,由 Form.Item 展示错误。
    } finally {
      setQuotaBusy(false);
    }
  };

  const copyEntry = (app: PublishedAppRecord) => {
    void navigator.clipboard?.writeText(entryUrl(app));
    void message.success("已复制员工入口链接");
  };

  const columns: ColumnsType<PublishedAppRecord> = [
      {
        title: "应用",
        dataIndex: "name",
        key: "name",
        render: (_: unknown, app: PublishedAppRecord) => (
          <Flex vertical gap={0}>
            <Typography.Text strong>{app.name}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {app.slug}
            </Typography.Text>
          </Flex>
        ),
      },
      {
        title: "入口",
        dataIndex: "slug",
        key: "entry",
        render: (_: unknown, app: PublishedAppRecord) => (
          <Flex align="center" gap={4}>
            <Typography.Text
              code
              ellipsis
              style={{ maxWidth: 220 }}
              title={entryUrl(app)}
            >
              {employeeEntryPath(app.slug, freshTokens[app.id] ?? null)}
            </Typography.Text>
            <Button
              type="text"
              size="small"
              icon={<CopyOutlined />}
              aria-label="复制员工入口链接"
              title="复制员工入口链接"
              onClick={() => copyEntry(app)}
            />
          </Flex>
        ),
      },
      {
        title: "访问",
        dataIndex: "accessMode",
        key: "access",
        render: (_: unknown, app: PublishedAppRecord) => (
          <Flex vertical gap={4} align="flex-start">
            <Tag color={app.accessMode === "token" ? "red" : "default"}>
              {app.accessMode === "token" ? "口令" : "公开"}
            </Tag>
            {app.accessMode === "token" ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {freshTokens[app.id] ?? app.accessTokenHint ?? "已设置"}
              </Typography.Text>
            ) : null}
            <Button type="link" size="small" onClick={() => void toggleAccess(app)}>
              {app.accessMode === "token" ? "撤销口令" : "加口令"}
            </Button>
          </Flex>
        ),
      },
      {
        title: "配额",
        key: "quota",
        render: (_: unknown, app: PublishedAppRecord) => (
          <Flex vertical gap={2} align="flex-start">
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              每分钟 {app.rateLimitPerMinute || "不限"} 次
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              每日 {app.dailyTokenBudget ? `${app.dailyTokenBudget} tokens` : "不限"}
            </Typography.Text>
            <Button type="link" size="small" style={{ padding: 0, height: 18 }} onClick={() => openQuota(app)}>
              调整配额
            </Button>
          </Flex>
        ),
      },
      {
        title: "能力",
        key: "capabilities",
        render: (_: unknown, app: PublishedAppRecord) => (
          <Flex gap={4} wrap>
            <Tag color="orange">知识库 {app.resources.rag?.sources?.length ?? 0}</Tag>
            <Tag color="blue">问数 {app.resources.sqlSources?.length ?? 0}</Tag>
            <Tag color={app.allowedGroups.length > 0 ? "green" : "default"}>
              分组 {app.allowedGroups.length > 0 ? app.allowedGroups.join(", ") : "仅公开"}
            </Tag>
          </Flex>
        ),
      },
      {
        title: "状态",
        dataIndex: "status",
        key: "status",
        render: (value: PublishedAppRecord["status"]) => (
          <Badge
            status={value === "ACTIVE" ? "success" : "default"}
            text={value === "ACTIVE" ? "已上线" : "已下线"}
          />
        ),
      },
      {
        title: "操作",
        key: "actions",
        render: (_: unknown, app: PublishedAppRecord) => (
          <Flex gap={4} align="center">
            <Button type="link" size="small" onClick={() => void toggleStatus(app)}>
              {app.status === "ACTIVE" ? "下线" : "上线"}
            </Button>
            <Popconfirm
              title={`删除发布应用「${app.name}」？`}
              description="员工入口将立即失效，该操作不可恢复。"
              okText="确认删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => void remove(app)}
            >
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined />}
                aria-label={`删除发布应用 ${app.name}`}
                title="删除"
              />
            </Popconfirm>
          </Flex>
        ),
      },
  ];

  return (
    <Flex vertical gap={12}>
      {error ? <Alert type="error" showIcon message={error} /> : null}

      <Flex align="flex-start" justify="space-between" gap={12}>
        <Flex vertical gap={2}>
          <Typography.Text
            type="secondary"
            style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2 }}
          >
            PUBLISHED APPS
          </Typography.Text>
          <Typography.Title level={5} style={{ margin: 0 }}>
            员工入口
          </Typography.Title>
        </Flex>
        <Tag>{apps.length} 个已发布应用</Tag>
      </Flex>
      <Typography.Paragraph type="secondary" style={{ fontSize: 13, margin: 0 }}>
        把知识库与工具打包成一个独立入口。员工打开链接即可问答，看不到
        Provider、资源抽屉与会话管理。
      </Typography.Paragraph>

      <Card size="small" title="发布新应用">
        <Form layout="vertical" onFinish={() => void create()}>
          <Form.Item label="应用名称" required>
            <Input
              aria-label="应用名称"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：制度问答助手"
            />
          </Form.Item>
          <Form.Item label="欢迎语" extra="显示在员工首次进入时">
            <Input
              aria-label="欢迎语"
              value={welcome}
              onChange={(event) => setWelcome(event.target.value)}
              placeholder="你好，我可以回答公司制度相关问题。"
            />
          </Form.Item>
          <Form.Item label="知识库来源" extra="员工提问只在这些文档中检索">
            <Select
              aria-label="知识库来源"
              mode="multiple"
              allowClear
              placeholder={catalog.loading ? "加载中…" : "选择知识库文档"}
              value={ragSources}
              onChange={setRagSources}
              options={(catalog.catalog?.rag.sources ?? []).map((source) => ({
                value: source.source,
                label: `${source.source}（${source.chunks} 段）`,
              }))}
            />
          </Form.Item>
          <Form.Item label="问数数据源" extra="可选，勾选后员工可直接问数">
            <Select
              aria-label="问数数据源"
              mode="multiple"
              allowClear
              placeholder={catalog.loading ? "加载中…" : "选择数据源"}
              value={sqlSources}
              onChange={setSqlSources}
              options={(catalog.catalog?.sql?.sources ?? []).map((source) => ({
                value: source.id,
                label: source.name,
              }))}
            />
          </Form.Item>
          <Form.Item
            label="文档可见分组（最大范围）"
            extra="可选；只接受网关签名断言与这里声明分组的交集"
          >
            <Input
              aria-label="文档可见分组"
              value={allowedGroupsText}
              onChange={(event) => setAllowedGroupsText(event.target.value)}
              placeholder="hr, finance, leadership"
            />
          </Form.Item>
          <Flex gap={8} justify="flex-end" wrap>
            <Button
              type="primary"
              htmlType="submit"
              icon={<PlusOutlined />}
              loading={busy}
              disabled={!name.trim()}
            >
              发布应用
            </Button>
            <Button icon={<ReloadOutlined />} onClick={() => void refresh()} loading={loading}>
              刷新
            </Button>
          </Flex>
        </Form>
      </Card>

      <Card
        size="small"
        title="可信身份接入"
        extra={
          <Tag color={identity?.enabled ? "green" : "orange"}>
            {identity?.enabled ? "已启用验证" : "未配置断言密钥"}
          </Tag>
        }
      >
        <Flex vertical gap={4}>
          <Typography.Text style={{ fontSize: 12 }}>
            请求头：{identity?.assertionHeader ?? "X-Viewer-Assertion"}
          </Typography.Text>
          <Typography.Text style={{ fontSize: 12 }}>Key ID：{identity?.keyId ?? "—"}</Typography.Text>
          <Typography.Text style={{ fontSize: 12 }}>Issuer：{identity?.issuer ?? "—"}</Typography.Text>
          <Typography.Text style={{ fontSize: 12 }}>
            Audience：{identity?.audience ?? "—"}
          </Typography.Text>
          <Typography.Text style={{ fontSize: 12 }}>
            身份模式：
            {identity?.identityMode === "required"
              ? "所有应用强制"
              : identity?.identityMode === "required_for_groups"
                ? "声明分组时强制"
                : "可选（无断言仅公开文档）"}
          </Typography.Text>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
            HMAC 密钥只配置在网关与 Agent Server 的 Secret 中，不会下发到浏览器。员工请求体不接受
            viewerGroups。
          </Typography.Paragraph>
        </Flex>
      </Card>

      <Card size="small" title="已发布应用" extra={<Tag>{apps.length}</Tag>}>
        <Table<PublishedAppRecord>
          size="small"
          rowKey="id"
          columns={columns}
          dataSource={apps}
          loading={loading}
          pagination={{ pageSize: 10, showSizeChanger: false }}
          scroll={{ x: "max-content" }}
          locale={{ emptyText: <Empty description="还没有发布应用" /> }}
        />
      </Card>

      <Modal
        centered
        title={quotaApp ? `调整配额-${quotaApp.name}` : "调整配额"}
        open={quotaApp !== null}
        onOk={() => void submitQuota()}
        onCancel={() => setQuotaApp(null)}
        okText="保存"
        cancelText="取消"
        confirmLoading={quotaBusy}
        destroyOnClose
      >
        <Form form={quotaForm} layout="vertical" preserve={false}>
          <Form.Item
            label="每分钟请求上限"
            name="rateLimitPerMinute"
            extra="0 = 不限"
            rules={[{ required: true, message: "请填写每分钟请求上限" }]}
          >
            <InputNumber aria-label="每分钟请求上限" min={0} precision={0} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            label="每日 token 预算"
            name="dailyTokenBudget"
            extra="0 = 不限"
            rules={[{ required: true, message: "请填写每日 token 预算" }]}
          >
            <InputNumber aria-label="每日 token 预算" min={0} precision={0} style={{ width: "100%" }} />
          </Form.Item>
        </Form>
      </Modal>
    </Flex>
  );
}
