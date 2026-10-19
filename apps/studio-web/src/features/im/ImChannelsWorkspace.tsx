import { useEffect, useMemo, useState } from "react";
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
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
} from "../../lib/icons.js";
import { StudioNotice, type StudioNoticeValue } from "../../components/studio/StudioNotice.js";
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
  const { message } = App.useApp();
  const [channels, setChannels] = useState<ImChannelMetadata[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [restartingId, setRestartingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<StudioNoticeValue | null>(null);

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
    if (!draft.name.trim()) {
      setError("请填写渠道名称");
      return;
    }
    if (!draft.appId.trim()) {
      setError("请填写 App ID");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await saveImChannel(draft);
      setDraft(null);
      await refresh();
      setNotice({ type: "success", text: `已保存渠道「${saved.name}」` });
      void message.success(`已保存渠道「${saved.name}」`);
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
      setNotice({ type: "success", text: `渠道「${channel.name}」重启指令已发送` });
      void message.success(`渠道「${channel.name}」重启指令已发送`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "渠道重启失败");
    } finally {
      setRestartingId(null);
    }
  };

  const remove = async (channel: ImChannelMetadata) => {
    setError(null);
    try {
      await removeImChannel(channel.id);
      await refresh();
      setNotice({ type: "success", text: `渠道「${channel.name}」已删除` });
      void message.success(`渠道「${channel.name}」已删除`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除失败");
    }
  };

  const columns: ColumnsType<ImChannelMetadata> = useMemo(
    () => [
      {
        title: "名称",
        dataIndex: "name",
        key: "name",
        render: (_: unknown, record: ImChannelMetadata) => (
          <Flex gap={8} align="center">
            <Badge status={record.enabled ? "success" : "default"} />
            <Typography.Text strong>{record.name}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {record.id.slice(0, 8)}
            </Typography.Text>
          </Flex>
        ),
      },
      {
        title: "平台",
        dataIndex: "platform",
        key: "platform",
        render: (value: ImPlatform) => <Tag>{IM_PLATFORM_LABELS[value]}</Tag>,
      },
      {
        title: "App ID",
        dataIndex: "appId",
        key: "appId",
        render: (value: string) => (
          <Typography.Text code ellipsis style={{ maxWidth: 160 }} title={value}>
            {value}
          </Typography.Text>
        ),
      },
      {
        title: "知识库",
        dataIndex: "ragSources",
        key: "ragSources",
        render: (value: string[]) => (
          <Flex gap={4} align="center" wrap>
            <Tag>{value.length}</Tag>
            <Typography.Text type="secondary" ellipsis style={{ maxWidth: 180 }} title={value.join(", ")}>
              {value.length > 0 ? value.join(", ") : "未绑定"}
            </Typography.Text>
          </Flex>
        ),
      },
      {
        title: "状态",
        dataIndex: "enabled",
        key: "enabled",
        render: (value: boolean) => (
          <Badge status={value ? "success" : "default"} text={value ? "启用" : "停用"} />
        ),
      },
      {
        title: "连接",
        dataIndex: "connected",
        key: "connected",
        render: (_: unknown, record: ImChannelMetadata) => (
          <Badge
            status={record.connected ? "success" : record.error ? "error" : "default"}
            text={record.connected ? "已连接" : record.error ? "异常" : "未连接"}
          />
        ),
      },
      {
        title: "操作",
        key: "actions",
        fixed: "right",
        width: 140,
        render: (_: unknown, record: ImChannelMetadata) => (
          <Flex gap={4}>
            <Tooltip title="重启连接">
              <Button
                type="text"
                icon={<ReloadOutlined spin={restartingId === record.id} />}
                aria-label={`重启 ${record.name}`}
                disabled={restartingId !== null}
                onClick={() => void restart(record)}
              />
            </Tooltip>
            <Tooltip title="编辑">
              <Button
                type="text"
                icon={<EditOutlined />}
                aria-label={`编辑 ${record.name}`}
                onClick={() => edit(record)}
              />
            </Tooltip>
            <Popconfirm
              title={`删除渠道「${record.name}」？`}
              description="机器人连接将立即断开，该操作不可恢复。"
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
          </Flex>
        ),
      },
    ],
    [restartingId],
  );

  return (
    <Flex vertical gap={12}>
      {error ? <Alert type="error" showIcon message={error} /> : null}
      <StudioNotice notice={notice} />
      <Flex align="flex-start" justify="space-between" gap={12}>
        <Flex vertical gap={2}>
          <Typography.Text type="secondary" style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2 }}>
            COLLABORATION ENTRY
          </Typography.Text>
          <Typography.Title level={5} style={{ margin: 0 }}>
            机器人渠道 <Tag style={{ marginLeft: 8 }}>{channels.length}</Tag>
          </Typography.Title>
        </Flex>
        <Flex gap={8}>
          <Button icon={<ReloadOutlined spin={loading} />} disabled={loading} onClick={() => void refresh()}>
            刷新
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setDraft(emptyDraft())}>
            新建渠道
          </Button>
        </Flex>
      </Flex>
      <Card size="small" styles={{ body: { padding: 0 } }}>
        <Table<ImChannelMetadata>
          size="small"
          rowKey="id"
          columns={columns}
          dataSource={channels}
          loading={loading}
          pagination={channels.length > 10 ? { pageSize: 10, showSizeChanger: false } : false}
          scroll={{ x: "max-content" }}
          locale={{ emptyText: <Empty description={loading ? "正在加载 IM 渠道..." : "还没有 IM 渠道"} /> }}
        />
      </Card>
      <ImChannelModal
        draft={draft}
        setDraft={setDraft}
        saving={saving}
        onCancel={() => setDraft(null)}
        onSubmit={() => void submit()}
      />
    </Flex>
  );
}

function ImChannelModal({
  draft,
  setDraft,
  saving,
  onCancel,
  onSubmit,
}: {
  draft: Draft | null;
  setDraft: (draft: Draft) => void;
  saving: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const [sourceInput, setSourceInput] = useState("");
  if (!draft) return null;
  const patch = (value: Partial<Draft>) => setDraft({ ...draft, ...value });
  const addSource = () => {
    const source = sourceInput.trim();
    if (source && !draft.ragSources.includes(source))
      patch({ ragSources: [...draft.ragSources, source] });
    setSourceInput("");
  };

  return (
    <Modal
      open
      title={draft.id ? "编辑渠道" : "新建渠道"}
      onCancel={onCancel}
      destroyOnClose={false}
      footer={
        <Flex gap={8} justify="flex-end">
          <Button onClick={onCancel}>取消</Button>
          <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={onSubmit}>
            {saving ? "保存中" : "保存渠道"}
          </Button>
        </Flex>
      }
    >
      <Form layout="vertical" preserve={false}>
        <Form.Item label="名称" required>
          <Input
            aria-label="渠道名称"
            value={draft.name}
            onChange={(event) => patch({ name: event.target.value })}
            placeholder="例如 研发群机器人"
          />
        </Form.Item>
        <Form.Item label="平台">
          <Select
            aria-label="平台"
            value={draft.platform}
            onChange={(value) => patch({ platform: value as ImPlatform })}
            options={IM_PLATFORMS.map((platform) => ({
              value: platform,
              label: IM_PLATFORM_LABELS[platform],
            }))}
          />
        </Form.Item>
        <Form.Item label="App ID" required>
          <Input
            aria-label="App ID"
            value={draft.appId}
            onChange={(event) => patch({ appId: event.target.value })}
            placeholder="cli_xxxxxxxx"
          />
        </Form.Item>
        <Form.Item
          label="App Secret"
          extra={draft.id ? "留空保持不变" : "必填"}
        >
          <Input.Password
            aria-label="App Secret"
            value={draft.appSecret}
            onChange={(event) => patch({ appSecret: event.target.value })}
            autoComplete="new-password"
          />
        </Form.Item>
        <Form.Item label="事件解密密钥" extra="可选，飞书 Encrypt Key / 钉钉加解密">
          <Input.Password
            aria-label="事件解密密钥"
            value={draft.encryptKey}
            onChange={(event) => patch({ encryptKey: event.target.value })}
            autoComplete="new-password"
          />
        </Form.Item>
        <Form.Item label="知识库绑定" extra="留空则机器人退化为纯 LLM 问答">
          <Flex vertical gap={8}>
            <Flex gap={4} wrap>
              {draft.ragSources.map((source) => (
                <Tag
                  key={source}
                  closable
                  onClose={() =>
                    patch({ ragSources: draft.ragSources.filter((item) => item !== source) })
                  }
                >
                  {source}
                </Tag>
              ))}
              {draft.ragSources.length === 0 ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  留空则机器人退化为纯 LLM 问答
                </Typography.Text>
              ) : null}
            </Flex>
            <Flex gap={8}>
              <Input
                aria-label="知识库 source 名"
                value={sourceInput}
                onChange={(event) => setSourceInput(event.target.value)}
                onPressEnter={addSource}
                placeholder="知识库 source 名，回车添加"
              />
              <Button icon={<PlusOutlined />} onClick={addSource} aria-label="添加知识库绑定">
                添加
              </Button>
            </Flex>
          </Flex>
        </Form.Item>
        <Form.Item label="检索条数" extra="1–20">
          <InputNumber
            aria-label="检索条数"
            min={1}
            max={20}
            value={draft.ragTopK}
            onChange={(value) => patch({ ragTopK: Math.min(20, Math.max(1, Number(value) || 5)) })}
            style={{ width: "100%" }}
          />
        </Form.Item>
        <Form.Item label="群聊需 @ 机器人" extra="关闭后群内所有消息都会响应（慎用）">
          <Switch
            aria-label="群聊需 @ 机器人"
            checked={draft.requireMention}
            onChange={(checked) => patch({ requireMention: checked })}
          />
        </Form.Item>
        <Form.Item label="启用渠道" extra="停用后立即断开机器人连接">
          <Switch
            aria-label="启用渠道"
            checked={draft.enabled}
            onChange={(checked) => patch({ enabled: checked })}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}

