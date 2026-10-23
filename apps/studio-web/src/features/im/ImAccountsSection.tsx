import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Flex,
  Form,
  Input,
  Modal,
  Select,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { EditOutlined, ReloadOutlined, SearchOutlined } from "../../lib/icons.js";
import { formatShortDateTime } from "../../lib/format.js";
import { fetchProviders, type ProviderMetadata } from "../providers/api.js";
import {
  fetchImAccounts,
  fetchImChannels,
  IM_PLATFORM_LABELS,
  IM_PLATFORMS,
  updateImAccount,
  type ImAccountChannelState,
  type ImChannelAccount,
  type ImChannelMetadata,
  type ImExternalUserIdType,
  type ImPlatform,
} from "./api.js";

const PAGE_SIZE = 20;

const USER_ID_TYPE_LABELS: Record<ImExternalUserIdType, string> = {
  feishu_open_id: "飞书 Open ID",
  dingtalk_staff_id: "钉钉 Staff ID",
  dingtalk_sender_id: "钉钉 Sender ID",
  dingtalk_user_id: "钉钉 User ID",
};

const CHANNEL_STATE_LABELS: Record<ImAccountChannelState, string> = {
  all: "全部渠道状态",
  existing: "渠道存在",
  deleted: "渠道已删除",
};

interface AccountDraft {
  account: ImChannelAccount;
  displayName: string;
  remark: string;
  providerId: string | null;
  model: string | null;
}

function interactionTime(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--" : formatShortDateTime(date.toISOString());
}

function accountLabel(account: ImChannelAccount): string {
  return account.displayName || account.externalName || account.externalUserId;
}

function userIdTypeLabel(type: ImExternalUserIdType | null): string {
  return type ? USER_ID_TYPE_LABELS[type] : "未知类型";
}

export function ImAccountsSection() {
  const { message } = App.useApp();
  const [accounts, setAccounts] = useState<ImChannelAccount[]>([]);
  const [total, setTotal] = useState(0);
  const [channels, setChannels] = useState<ImChannelMetadata[]>([]);
  const [providers, setProviders] = useState<ProviderMetadata[]>([]);
  const [providerCatalogError, setProviderCatalogError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [keywordInput, setKeywordInput] = useState("");
  const [keyword, setKeyword] = useState("");
  const [platform, setPlatform] = useState<ImPlatform | undefined>();
  const [channelId, setChannelId] = useState<string | undefined>();
  const [channelState, setChannelState] = useState<ImAccountChannelState>("all");
  const [draft, setDraft] = useState<AccountDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setProviderCatalogError(null);
    void fetchImChannels()
      .then((nextChannels) => {
        if (active) setChannels(nextChannels);
      })
      .catch(() => {
        if (active) setChannels([]);
      });
    void fetchProviders({ includeDisabled: true })
      .then((nextProviders) => {
        if (active) setProviders(nextProviders);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setProviders([]);
        setProviderCatalogError(reason instanceof Error ? reason.message : "Provider 目录加载失败");
      });
    return () => {
      active = false;
    };
  }, [revision]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void fetchImAccounts({
      ...(platform ? { platform } : {}),
      ...(channelId ? { channelId } : {}),
      ...(keyword ? { keyword } : {}),
      channelState,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    })
      .then((result) => {
        if (!active) return;
        setAccounts(result.items);
        setTotal(result.total);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setAccounts([]);
        setTotal(0);
        setError(reason instanceof Error ? reason.message : "IM 账号加载失败");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [channelId, channelState, keyword, page, platform, revision]);

  const updateFilter = (apply: () => void) => {
    apply();
    setPage(1);
  };

  const refresh = () => setRevision((value) => value + 1);

  const edit = (account: ImChannelAccount) => {
    setModalError(null);
    setDraft({
      account,
      displayName: account.displayName ?? "",
      remark: account.remark ?? "",
      providerId: account.providerId,
      model: account.model,
    });
  };

  const submit = async () => {
    if (!draft) return;
    if (draft.providerId && !draft.model) {
      setModalError("请选择模型，或清除 Provider 绑定以跟随系统默认");
      return;
    }
    setSaving(true);
    setModalError(null);
    try {
      const bindingChanged =
        draft.providerId !== draft.account.providerId || draft.model !== draft.account.model;
      const saved = await updateImAccount(draft.account.id, {
        displayName: draft.displayName.trim() || null,
        remark: draft.remark.trim() || null,
        ...(bindingChanged
          ? {
              providerId: draft.providerId,
              model: draft.model,
            }
          : {}),
      });
      setDraft(null);
      refresh();
      void message.success(`已更新账号「${accountLabel(saved)}」`);
    } catch (reason) {
      setModalError(reason instanceof Error ? reason.message : "IM 账号保存失败");
    } finally {
      setSaving(false);
    }
  };

  const columns: ColumnsType<ImChannelAccount> = useMemo(
    () => [
      {
        title: "账号",
        key: "account",
        width: 220,
        render: (_: unknown, record) => (
          <Flex vertical gap={2}>
            <Typography.Text strong>{accountLabel(record)}</Typography.Text>
            {record.displayName && record.externalName ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                外部名称：{record.externalName}
              </Typography.Text>
            ) : null}
            <Typography.Text code ellipsis style={{ maxWidth: 200 }} title={record.externalUserId}>
              {record.externalUserId}
            </Typography.Text>
          </Flex>
        ),
      },
      {
        title: "来源渠道",
        key: "channel",
        width: 210,
        render: (_: unknown, record) => (
          <Flex vertical gap={5} align="flex-start">
            <Flex gap={6} align="center" wrap>
              <Typography.Text strong>{record.channelName}</Typography.Text>
              {record.channelDeleted ? <Tag color="red">已删除</Tag> : <Tag>使用中</Tag>}
            </Flex>
            <Tag color={record.platform === "feishu" ? "blue" : "gold"}>
              {IM_PLATFORM_LABELS[record.platform]}
            </Tag>
          </Flex>
        ),
      },
      {
        title: "身份标识",
        key: "identity",
        width: 170,
        render: (_: unknown, record) => (
          <Flex vertical gap={2}>
            <Typography.Text>{userIdTypeLabel(record.externalUserIdType)}</Typography.Text>
            {record.remark ? (
              <Typography.Text type="secondary" ellipsis style={{ maxWidth: 160 }}>
                {record.remark}
              </Typography.Text>
            ) : null}
          </Flex>
        ),
      },
      {
        title: "最近对话",
        key: "interaction",
        width: 180,
        render: (_: unknown, record) => (
          <Flex vertical gap={2}>
            <Typography.Text>{interactionTime(record.lastInteractedAt)}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {record.lastChatType === "group"
                ? "群聊"
                : record.lastChatType === "p2p"
                  ? "私聊"
                  : "对话"}
              {record.lastConversationId ? ` · ${record.lastConversationId}` : ""}
            </Typography.Text>
          </Flex>
        ),
      },
      {
        title: "模型绑定",
        key: "model",
        width: 230,
        render: (_: unknown, record) => {
          if (record.bindingStatus === "unbound") {
            return <Tag>系统默认</Tag>;
          }
          return (
            <Flex vertical gap={3} align="flex-start">
              <Typography.Text>
                {record.providerName || record.providerId || "未知 Provider"}
              </Typography.Text>
              <Flex gap={5} align="center" wrap>
                <Tag color={record.bindingStatus === "valid" ? "green" : "red"}>
                  {record.model || "未选择模型"}
                </Tag>
                {record.bindingStatus === "invalid" ? (
                  <Typography.Text type="danger" style={{ fontSize: 12 }}>
                    运行时回退系统默认
                  </Typography.Text>
                ) : null}
              </Flex>
            </Flex>
          );
        },
      },
      {
        title: "备注",
        dataIndex: "remark",
        key: "remark",
        ellipsis: true,
        render: (value: string | null) =>
          value || <Typography.Text type="secondary">—</Typography.Text>,
      },
      {
        title: "操作",
        key: "actions",
        width: 80,
        fixed: "right",
        render: (_: unknown, record) => (
          <Tooltip title="编辑账号">
            <Button
              type="text"
              icon={<EditOutlined />}
              aria-label={`编辑账号 ${accountLabel(record)}`}
              onClick={() => edit(record)}
            />
          </Tooltip>
        ),
      },
    ],
    [],
  );

  return (
    <Flex vertical gap={12}>
      {error ? <Alert type="error" showIcon message={error} /> : null}
      {providerCatalogError ? (
        <Alert
          type="warning"
          showIcon
          message={`Provider 目录加载失败：${providerCatalogError}`}
          description="账号列表仍可查看，但暂时无法修改模型绑定。"
          action={
            <Button size="small" onClick={refresh}>
              重试
            </Button>
          }
        />
      ) : null}
      <Flex align="flex-start" justify="space-between" gap={12} wrap>
        <Flex vertical gap={2}>
          <Typography.Text
            type="secondary"
            style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2 }}
          >
            IM ACCOUNT DIRECTORY
          </Typography.Text>
          <Typography.Title level={5} style={{ margin: 0 }}>
            对话账号 <Tag style={{ marginLeft: 8 }}>{total}</Tag>
          </Typography.Title>
          <Typography.Text type="secondary">
            通过有效 IM 对话自动记录；渠道删除后账号与对话历史仍保留。
          </Typography.Text>
        </Flex>
        <Button icon={<ReloadOutlined spin={loading} />} disabled={loading} onClick={refresh}>
          刷新
        </Button>
      </Flex>

      <Card size="small">
        <Flex gap={8} wrap align="center">
          <Input
            allowClear
            aria-label="搜索 IM 账号"
            prefix={<SearchOutlined />}
            placeholder="搜索名称、外部 ID、渠道或备注"
            value={keywordInput}
            onChange={(event) => setKeywordInput(event.target.value)}
            onPressEnter={() => updateFilter(() => setKeyword(keywordInput.trim()))}
            style={{ width: 280 }}
          />
          <Button
            icon={<SearchOutlined />}
            onClick={() => updateFilter(() => setKeyword(keywordInput.trim()))}
          >
            搜索
          </Button>
          <Select<ImPlatform>
            allowClear
            aria-label="按 IM 平台筛选"
            placeholder="全部平台"
            value={platform}
            onChange={(value) => updateFilter(() => setPlatform(value))}
            options={IM_PLATFORMS.map((value) => ({
              value,
              label: IM_PLATFORM_LABELS[value],
            }))}
            style={{ width: 130 }}
          />
          <Select<string>
            allowClear
            showSearch
            optionFilterProp="label"
            aria-label="按渠道筛选"
            placeholder="全部渠道"
            value={channelId}
            onChange={(value) => updateFilter(() => setChannelId(value))}
            options={channels.map((channel) => ({
              value: channel.id,
              label: `${channel.name} · ${IM_PLATFORM_LABELS[channel.platform]}`,
            }))}
            style={{ width: 220 }}
          />
          <Select<ImAccountChannelState>
            aria-label="按渠道状态筛选"
            value={channelState}
            onChange={(value) => updateFilter(() => setChannelState(value))}
            options={(Object.keys(CHANNEL_STATE_LABELS) as ImAccountChannelState[]).map(
              (value) => ({
                value,
                label: CHANNEL_STATE_LABELS[value],
              }),
            )}
            style={{ width: 150 }}
          />
        </Flex>
      </Card>

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <Table<ImChannelAccount>
          size="small"
          rowKey="id"
          columns={columns}
          dataSource={accounts}
          loading={loading}
          scroll={{ x: "max-content" }}
          pagination={{
            current: page,
            pageSize: PAGE_SIZE,
            total,
            showSizeChanger: false,
            showTotal: (count) => `共 ${count} 个账号`,
            onChange: setPage,
          }}
          locale={{
            emptyText: (
              <Empty
                description={
                  loading
                    ? "正在加载 IM 账号..."
                    : "还没有账号。用户通过 IM 渠道完成一次有效对话后会自动出现。"
                }
              />
            ),
          }}
        />
      </Card>

      <AccountEditModal
        draft={draft}
        providers={providers}
        saving={saving}
        error={modalError}
        setDraft={setDraft}
        onCancel={() => setDraft(null)}
        onSubmit={() => void submit()}
      />
    </Flex>
  );
}

function AccountEditModal({
  draft,
  providers,
  saving,
  error,
  setDraft,
  onCancel,
  onSubmit,
}: {
  draft: AccountDraft | null;
  providers: ProviderMetadata[];
  saving: boolean;
  error: string | null;
  setDraft: (draft: AccountDraft) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  if (!draft) return null;
  const patch = (value: Partial<AccountDraft>) => setDraft({ ...draft, ...value });
  const selectedProvider = providers.find((provider) => provider.id === draft.providerId);
  const providerOptions = providers.map((provider) => ({
    value: provider.id,
    label: `${provider.name}${provider.enabled ? "" : "（已停用）"}`,
    disabled: !provider.enabled,
  }));
  if (draft.providerId && !selectedProvider) {
    providerOptions.unshift({
      value: draft.providerId,
      label: `${draft.providerId}（Provider 不存在）`,
      disabled: true,
    });
  }
  const modelOptions = (selectedProvider?.models ?? []).map((model) => ({
    value: model,
    label: model,
  }));
  if (draft.model && !modelOptions.some((option) => option.value === draft.model)) {
    modelOptions.unshift({ value: draft.model, label: `${draft.model}（当前不可用）` });
  }

  return (
    <Modal
      centered
      open
      title="编辑 IM 账号"
      onCancel={onCancel}
      destroyOnHidden={false}
      footer={
        <Flex gap={8} justify="flex-end">
          <Button onClick={onCancel}>取消</Button>
          <Button type="primary" loading={saving} onClick={onSubmit}>
            {saving ? "保存中" : "保存账号"}
          </Button>
        </Flex>
      }
    >
      <Flex vertical gap={12}>
        {error ? <Alert type="error" showIcon message={error} /> : null}
        {draft.account.bindingStatus === "invalid" ? (
          <Alert
            type="warning"
            showIcon
            message="当前模型绑定已失效"
            description="对话会回退到系统默认模型。可以重新选择 Provider/模型，或清除绑定。"
          />
        ) : null}
        <Card size="small">
          <Flex vertical gap={4}>
            <Typography.Text strong>{accountLabel(draft.account)}</Typography.Text>
            <Typography.Text type="secondary">
              {draft.account.channelName} · {IM_PLATFORM_LABELS[draft.account.platform]} ·{" "}
              {userIdTypeLabel(draft.account.externalUserIdType)}
            </Typography.Text>
            <Typography.Text code>{draft.account.externalUserId}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              外部名称由渠道通讯录自动同步，后台只能编辑显示名、备注和模型绑定。
            </Typography.Text>
          </Flex>
        </Card>
        <Form layout="vertical">
          <Form.Item label="显示名" extra="留空后列表回退显示渠道提供的名称或外部用户 ID">
            <Input
              aria-label="账号显示名"
              value={draft.displayName}
              onChange={(event) => patch({ displayName: event.target.value })}
              placeholder={draft.account.externalName || draft.account.externalUserId}
            />
          </Form.Item>
          <Form.Item label="备注">
            <Input.TextArea
              aria-label="账号备注"
              value={draft.remark}
              onChange={(event) => patch({ remark: event.target.value })}
              autoSize={{ minRows: 3, maxRows: 6 }}
              maxLength={1000}
              showCount
              placeholder="例如客户等级、负责人或跟进说明"
            />
          </Form.Item>
          <Form.Item
            label="Provider / 模型"
            extra="不绑定则跟随系统默认模型；绑定失效时运行时自动回退默认模型"
          >
            <Flex vertical gap={8}>
              <Select<string>
                allowClear
                showSearch
                optionFilterProp="label"
                aria-label="账号 Provider"
                placeholder="跟随系统默认"
                value={draft.providerId ?? undefined}
                options={providerOptions}
                onChange={(value) => {
                  const provider = providers.find((item) => item.id === value);
                  patch({
                    providerId: value ?? null,
                    model: value ? (provider?.models[0] ?? null) : null,
                  });
                }}
              />
              <Select<string>
                allowClear={false}
                aria-label="账号模型"
                placeholder={draft.providerId ? "请选择模型" : "请先选择 Provider"}
                disabled={!draft.providerId}
                value={draft.model ?? undefined}
                options={modelOptions}
                onChange={(value) => patch({ model: value ?? null })}
              />
            </Flex>
          </Form.Item>
        </Form>
      </Flex>
    </Modal>
  );
}
