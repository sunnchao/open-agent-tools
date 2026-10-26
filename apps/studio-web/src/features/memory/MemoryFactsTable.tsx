import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Flex, Input, Select, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined, SearchOutlined } from "../../lib/icons.js";
import {
  MEMORY_KIND_LABEL,
  MEMORY_SCOPE_LABEL,
  MEMORY_STATUS_LABEL,
  fetchMemoryFacts,
  type MemoryFact,
  type MemoryKind,
  type MemoryScopeKind,
  type MemoryStatus,
} from "./api.js";

const PAGE_SIZE = 50;

const STATUS_COLOR: Record<MemoryStatus, string> = {
  active: "green",
  superseded: "default",
  expired: "orange",
};

const KIND_COLOR: Record<MemoryKind, string> = {
  preference: "blue",
  fact: "geekblue",
  decision: "purple",
  constraint: "volcano",
};

/** 事实库：筛选、分页与详情入口。详情抽屉由工作区统一托管，保证路由一致。 */
export function MemoryFactsTable({
  factId,
  onOpenFact,
  onChanged,
}: {
  factId: string | null;
  onOpenFact: (id: string | null) => void;
  /** 抽屉里审核后通知外层刷新统计。 */
  onChanged?: () => void;
}) {
  const [facts, setFacts] = useState<MemoryFact[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [keyword, setKeyword] = useState("");
  const [scopeKind, setScopeKind] = useState<MemoryScopeKind | undefined>();
  const [status, setStatus] = useState<MemoryStatus | "all">("all");
  const [revision, setRevision] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const page = await fetchMemoryFacts({
        ...(scopeKind ? { scopeKind } : {}),
        ...(keyword.trim() ? { keyword: keyword.trim() } : {}),
        status,
        includeUnreviewed: true,
        limit: PAGE_SIZE,
        offset,
      });
      setFacts(page.facts);
      setTotal(page.total);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [keyword, scopeKind, status, offset]);

  useEffect(() => {
    void load();
  }, [load, revision, onChanged]);

  // 筛选变化时回到第一页，避免停在越界 offset 上看到空表。
  useEffect(() => {
    setOffset(0);
  }, [keyword, scopeKind, status]);

  const columns = useMemo<ColumnsType<MemoryFact>>(
    () => [
      {
        title: "主体",
        dataIndex: "subject",
        width: 220,
        render: (_: unknown, fact) => (
          <Flex vertical gap={2}>
            <Typography.Text ellipsis style={{ maxWidth: 200 }} title={fact.subject}>
              {fact.subject}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {MEMORY_SCOPE_LABEL[fact.scopeKind]} · {fact.slug}
            </Typography.Text>
          </Flex>
        ),
      },
      {
        title: "类型",
        dataIndex: "kind",
        width: 96,
        render: (kind: MemoryKind) => <Tag color={KIND_COLOR[kind]}>{MEMORY_KIND_LABEL[kind]}</Tag>,
      },
      {
        title: "内容",
        dataIndex: "body",
        render: (body: string, fact) => (
          <Flex vertical gap={2}>
            <Typography.Paragraph
              ellipsis={{ rows: 2, expandable: false }}
              style={{ margin: 0, maxWidth: 520 }}
            >
              {body}
            </Typography.Paragraph>
            {fact.unreviewed ? <Tag color="gold">待审核</Tag> : null}
          </Flex>
        ),
      },
      {
        title: "状态",
        dataIndex: "status",
        width: 96,
        render: (value: MemoryStatus, fact) => (
          <Flex vertical gap={2}>
            <Tag color={STATUS_COLOR[value]}>{MEMORY_STATUS_LABEL[value]}</Tag>
            {fact.validTo ? (
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                至 {fact.validTo}
              </Typography.Text>
            ) : null}
          </Flex>
        ),
      },
      {
        title: "更新时间",
        dataIndex: "updatedAt",
        width: 150,
        render: (value: number) => (
          <Typography.Text style={{ fontSize: 12 }}>
            {new Date(value).toLocaleString("zh-CN")}
          </Typography.Text>
        ),
      },
      {
        title: "操作",
        key: "actions",
        width: 96,
        render: (_: unknown, fact) => (
          <Button
            type="link"
            size="small"
            aria-current={fact.id === factId ? "true" : undefined}
            onClick={() => onOpenFact(fact.id)}
          >
            详情
          </Button>
        ),
      },
    ],
    [onOpenFact, factId],
  );

  return (
    <Flex vertical gap={12}>
      <Flex gap={8} wrap align="center">
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="搜索 slug / 主体 / 内容"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          style={{ width: 280 }}
          aria-label="搜索记忆"
        />
        <Select
          allowClear
          placeholder="作用域"
          value={scopeKind}
          onChange={(value) => setScopeKind(value as MemoryScopeKind | undefined)}
          options={[
            { value: "person", label: "个人" },
            { value: "group", label: "群组" },
          ]}
          style={{ width: 120 }}
          aria-label="按作用域筛选"
        />
        <Select
          value={status}
          onChange={(value) => setStatus(value as MemoryStatus | "all")}
          options={[
            { value: "all", label: "全部状态" },
            { value: "active", label: "生效中" },
            { value: "superseded", label: "已失效" },
            { value: "expired", label: "已过期" },
          ]}
          style={{ width: 130 }}
          aria-label="按状态筛选"
        />
        <Button icon={<ReloadOutlined />} size="small" onClick={() => setRevision((v) => v + 1)}>
          刷新
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          共 {total} 条
        </Typography.Text>
      </Flex>

      {error ? (
        <Alert
          type="error"
          showIcon
          role="alert"
          message={`记忆列表加载失败：${error}`}
          action={
            <Button size="small" onClick={() => setRevision((value) => value + 1)}>
              重试
            </Button>
          }
        />
      ) : null}

      <Table<MemoryFact>
        size="small"
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={facts}
        locale={{
          emptyText: keyword || scopeKind || status !== "all" ? "没有符合条件的记忆" : "还没有记忆",
        }}
        pagination={{
          current: Math.floor(offset / PAGE_SIZE) + 1,
          pageSize: PAGE_SIZE,
          total,
          showSizeChanger: false,
          onChange: (page) => setOffset((page - 1) * PAGE_SIZE),
        }}
      />

      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        提示：记忆默认以“待审核”写入，审核通过后才会被自动召回。删除聊天记录不会删除记忆，
        需要在此处或遗忘流程中显式清理。
      </Typography.Text>
    </Flex>
  );
}
