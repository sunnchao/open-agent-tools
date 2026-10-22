import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Empty,
  Flex,
  Form,
  Input,
  Pagination,
  Select,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined, SearchOutlined } from "../../lib/icons.js";
import { fetchImChannels, IM_PLATFORM_LABELS } from "../im/api.js";
import { localTimeToTimestamp, TimeRangeInput } from "./TimeRangeInput.js";
import { WorkspaceSelect } from "./WorkspaceSelect.js";
import { fetchImChatAudits, type ImChatAuditRecord, type AuditDetailSelection } from "./api.js";

import {
  chatTypeLabel,
  detailColumn,
  formatTime,
  platformLabel,
  statusColor,
  statusLabel,
} from "./auditPresentation.js";

const PAGE_SIZE = 20;

function formatDuration(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(2)}s`;
}

export function ImAuditView({
  workspace,
  onViewDetails,
}: {
  workspace?: string;
  onViewDetails: (selection: AuditDetailSelection) => void;
}) {
  const [records, setRecords] = useState<ImChatAuditRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);

  const [selectedWorkspace, setSelectedWorkspace] = useState(workspace ?? "");
  const [platform, setPlatform] = useState("");
  const [channelId, setChannelId] = useState("");
  const [actor, setActor] = useState("");
  const [chatType, setChatType] = useState("");
  const [status, setStatus] = useState("");
  const [fromText, setFromText] = useState("");
  const [toText, setToText] = useState("");
  const [search, setSearch] = useState("");
  const [keyword, setKeyword] = useState("");

  const [channels, setChannels] = useState<Array<{ id: string; name: string; platform: string }>>(
    [],
  );
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    let active = true;
    void fetchImChannels()
      .then((list) => {
        if (!active) return;
        setChannels(
          list.map((item) => ({ id: item.id, name: item.name, platform: item.platform })),
        );
      })
      .catch(() => {
        // 渠道元数据缺失不应阻断审计列表，仅失去渠道下拉的候选项。
        if (active) setChannels([]);
      });
    return () => {
      active = false;
    };
  }, []);

  const filters = useMemo(
    () => ({
      workspace: selectedWorkspace || undefined,
      platform: platform || undefined,
      channelId: channelId || undefined,
      actor: actor.trim() || undefined,
      chatType: chatType || undefined,
      status: status || undefined,
      from: localTimeToTimestamp(fromText),
      to: localTimeToTimestamp(toText),
      keyword: keyword || undefined,
    }),
    [selectedWorkspace, platform, channelId, actor, chatType, status, fromText, toText, keyword],
  );

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void fetchImChatAudits({ ...filters, limit: PAGE_SIZE, offset })
      .then((next) => {
        if (!active) return;
        setRecords(next.records);
        setTotal(next.total);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [filters, offset, revision]);

  const viewDetails = (item: ImChatAuditRecord) => {
    if (!item.id) return;
    onViewDetails({
      kind: "im",
      id: item.id,
      workspace: item.workspace || selectedWorkspace || undefined,
    });
  };

  const columns: ColumnsType<ImChatAuditRecord> = [
    {
      title: "时间",
      dataIndex: "createdAt",
      key: "createdAt",
      width: 170,
      render: (value: string) => (
        <Typography.Text style={{ fontSize: 12 }}>{formatTime(value)}</Typography.Text>
      ),
    },
    {
      title: "渠道",
      key: "channel",
      width: 170,
      render: (_: unknown, item: ImChatAuditRecord) => (
        <Flex vertical gap={2}>
          {/* Tag 放进 align="center" 的内层 Flex：竖向 Flex 默认 align:stretch，
              直接放 Tag 会被拉成整列宽的色块。 */}
          <Flex align="center" gap={0}>
            <Tag color={item.platform === "dingtalk" ? "blue" : "cyan"}>
              {platformLabel(item.platform) || "未知平台"}
            </Tag>
          </Flex>
          <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>
            {item.channelName ?? item.channelId ?? "—"}
          </Typography.Text>
        </Flex>
      ),
    },
    {
      title: "用户",
      key: "actor",
      width: 160,
      render: (_: unknown, item: ImChatAuditRecord) => (
        <Flex vertical gap={0}>
          <Typography.Text style={{ fontSize: 12 }} ellipsis title={item.actor}>
            {item.actor || "—"}
          </Typography.Text>
          {item.actorName ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>
              {item.actorName}
            </Typography.Text>
          ) : null}
        </Flex>
      ),
    },
    {
      title: "会话类型",
      dataIndex: "chatType",
      key: "chatType",
      width: 90,
      render: (value: string) => <Tag variant="filled">{chatTypeLabel(value)}</Tag>,
    },
    {
      title: "问题摘要",
      dataIndex: "question",
      key: "question",
      ellipsis: true,
      render: (value: string) => (
        <Typography.Text style={{ fontSize: 12 }} ellipsis title={value}>
          {value || "—"}
        </Typography.Text>
      ),
    },
    {
      title: "回答摘要",
      dataIndex: "answer",
      key: "answer",
      ellipsis: true,
      render: (value: string) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis title={value}>
          {value || "—"}
        </Typography.Text>
      ),
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 100,
      render: (value: string) => (
        <Badge
          status={statusColor(value) as "success" | "error" | "warning" | "default"}
          text={statusLabel(value)}
        />
      ),
    },
    {
      title: "耗时",
      dataIndex: "durationMs",
      key: "durationMs",
      width: 90,
      render: (value: number) => (
        <Typography.Text style={{ fontSize: 12 }}>{formatDuration(value)}</Typography.Text>
      ),
    },
    {
      title: "工具调用",
      dataIndex: "toolCalls",
      key: "toolCalls",
      width: 90,
      render: (value: number) => (
        <Typography.Text style={{ fontSize: 12 }}>{value}</Typography.Text>
      ),
    },
    detailColumn(viewDetails),
  ];

  const channelOptions = useMemo(() => {
    const filtered = platform ? channels.filter((item) => item.platform === platform) : channels;
    return filtered.map((item) => ({
      value: item.id,
      label: `${item.name}（${platformLabel(item.platform)}）`,
    }));
  }, [channels, platform]);

  return (
    <Flex vertical gap={12} className="audit-panel">
      <Card size="small" className="audit-filters">
        <Form
          layout="inline"
          style={{ rowGap: 8, flexWrap: "wrap" }}
          onFinish={() => {
            setKeyword(search.trim());
            setOffset(0);
            refresh();
          }}
        >
          <Form.Item style={{ marginBottom: 0, minWidth: 200, flex: 1 }}>
            <Input.Search
              aria-label="搜索 IM 审计记录"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onSearch={(value) => {
                setKeyword(value.trim());
                setOffset(0);
                refresh();
              }}
              placeholder="搜索问题、回答或用户"
              allowClear
            />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <WorkspaceSelect
              ariaLabel="IM 审计工作区"
              value={selectedWorkspace}
              onChange={(next) => {
                setSelectedWorkspace(next);
                setOffset(0);
              }}
            />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <Select
              aria-label="IM 审计平台"
              value={platform}
              onChange={(value) => {
                setPlatform(value);
                setChannelId("");
                setOffset(0);
              }}
              options={[
                { value: "", label: "全部平台" },
                ...Object.entries(IM_PLATFORM_LABELS).map(([itemValue, itemLabel]) => ({
                  value: itemValue,
                  label: itemLabel,
                })),
              ]}
              style={{ width: 120 }}
            />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <Select
              aria-label="IM 审计渠道"
              value={channelId}
              onChange={(value) => {
                setChannelId(value);
                setOffset(0);
              }}
              options={[{ value: "", label: "全部渠道" }, ...channelOptions]}
              style={{ width: 180 }}
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <Input
              aria-label="IM 审计用户"
              value={actor}
              onChange={(event) => setActor(event.target.value)}
              placeholder="用户 ID / 姓名"
              style={{ width: 140 }}
            />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <Select
              aria-label="IM 审计会话类型"
              value={chatType}
              onChange={(value) => {
                setChatType(value);
                setOffset(0);
              }}
              options={[
                { value: "", label: "全部类型" },
                { value: "p2p", label: "单聊" },
                { value: "group", label: "群聊" },
              ]}
              style={{ width: 120 }}
            />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <Select
              aria-label="IM 审计状态"
              value={status}
              onChange={(value) => {
                setStatus(value);
                setOffset(0);
              }}
              options={[
                { value: "", label: "全部状态" },
                { value: "ok", label: "成功" },
                { value: "error", label: "失败" },
              ]}
              style={{ width: 110 }}
            />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <TimeRangeInput
              ariaLabel="IM 审计时间"
              from={fromText}
              to={toText}
              onChange={({ from: nextFrom, to: nextTo }) => {
                setFromText(nextFrom);
                setToText(nextTo);
                setOffset(0);
              }}
            />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <Flex gap={8} align="center" wrap>
              <Button type="primary" htmlType="submit" icon={<SearchOutlined />}>
                搜索
              </Button>
              <Tooltip title="刷新">
                <Button icon={<ReloadOutlined />} onClick={refresh} aria-label="刷新 IM 审计记录" />
              </Tooltip>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {total} 条记录
              </Typography.Text>
            </Flex>
          </Form.Item>
        </Form>
      </Card>

      {error ? <Alert type="error" showIcon message={error} role="alert" /> : null}

      <Card size="small" className="audit-table-card" styles={{ body: { padding: 0 } }}>
        <Table<ImChatAuditRecord>
          size="small"
          rowKey={(item) => item.id || `${item.createdAt}:${item.actor}`}
          columns={columns}
          dataSource={records}
          loading={loading}
          pagination={false}
          scroll={{ x: "max-content", y: "100%" }}
          onRow={(item) => ({
            onClick: () => viewDetails(item),
            className: item.id ? "audit-log-row" : undefined,
          })}
          locale={{ emptyText: <Empty description="暂无匹配的 IM 会话审计记录" /> }}
        />
        <Flex justify="flex-end" className="audit-pagination" style={{ padding: 12 }}>
          <Pagination
            size="small"
            current={Math.floor(offset / PAGE_SIZE) + 1}
            total={total}
            pageSize={PAGE_SIZE}
            showSizeChanger={false}
            onChange={(page) => setOffset((page - 1) * PAGE_SIZE)}
            disabled={loading}
          />
        </Flex>
      </Card>
    </Flex>
  );
}
