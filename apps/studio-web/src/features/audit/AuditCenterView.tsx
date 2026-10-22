import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Empty,
  Flex,
  Pagination,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined } from "../../lib/icons.js";
import { localTimeToTimestamp, TimeRangeInput } from "./TimeRangeInput.js";
import { WorkspaceSelect } from "./WorkspaceSelect.js";
import { type QueryAuditStatus, type QueryAuditSummary } from "../observatory/api.js";
import {
  AUDIT_STATUS_LABELS,
  auditStatusTag,
  formatDuration,
} from "../observatory/QueryExecution.js";
import { ImAuditView } from "./ImAuditView.js";
import {
  fetchAuditOverview,
  fetchQueryAuditSummaries,
  fetchMcpAuditEvents,
  fetchUsageEvents,
  type AuditOverview,
  type UsageEventRecord,
  type AuditDetailSelection,
} from "./api.js";
import type { AuditEventSummary } from "../mcp/api.js";
import { detailColumn } from "./auditPresentation.js";

const PAGE_SIZE = 20;

type AuditTabKey = "im" | "query" | "usage" | "mcp";
type ViewDetails = (selection: AuditDetailSelection) => void;

/** 统一审计中心：IM 会话 / 问数 / 用量 / MCP 平台 四个来源并行聚合。 */
export function AuditCenterView({ onViewDetails }: { onViewDetails: ViewDetails }) {
  const [tab, setTab] = useState<AuditTabKey>("im");
  const [workspace, setWorkspace] = useState("");
  const [fromText, setFromText] = useState("");
  const [toText, setToText] = useState("");
  const [revision, setRevision] = useState(0);
  const [overview, setOverview] = useState<AuditOverview | null>(null);
  const [overviewError, setOverviewError] = useState("");

  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  // IM 审计按毫秒时间戳过滤。
  const range = useMemo(
    () => ({
      from: localTimeToTimestamp(fromText),
      to: localTimeToTimestamp(toText),
    }),
    [fromText, toText],
  );

  // 问数审计的时间参数是 ISO 字符串（与 IM 审计的毫秒时间戳口径不同）。
  const queryRange = useMemo(() => {
    const from = localTimeToTimestamp(fromText);
    const to = localTimeToTimestamp(toText);
    return {
      from: from !== undefined ? new Date(from).toISOString() : undefined,
      to: to !== undefined ? new Date(to).toISOString() : undefined,
    };
  }, [fromText, toText]);

  // 概览给出各分节的条数（MCP 平台审计不在其中，由 Control Plane 独立提供）。
  useEffect(() => {
    let active = true;
    void fetchAuditOverview({
      workspace: workspace || undefined,
      from: range.from,
      to: range.to,
      limit: 5,
    })
      .then((next) => {
        if (!active) return;
        setOverview(next);
        setOverviewError("");
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setOverview(null);
        setOverviewError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
    };
  }, [workspace, range.from, range.to, revision]);

  return (
    <Flex vertical gap={12} className="audit-panel">
      <Card size="small" className="audit-filters">
        <Flex gap={8} align="center" wrap>
          <WorkspaceSelect ariaLabel="统一审计工作区" value={workspace} onChange={setWorkspace} />
          <TimeRangeInput
            ariaLabel="统一审计时间"
            from={fromText}
            to={toText}
            onChange={({ from, to }) => {
              setFromText(from);
              setToText(to);
            }}
          />
          <Tooltip title="刷新">
            <Button icon={<ReloadOutlined />} onClick={refresh} aria-label="刷新统一审计中心" />
          </Tooltip>
        </Flex>
        {overviewError ? (
          <Alert
            type="warning"
            showIcon
            role="alert"
            style={{ marginTop: 8 }}
            message={`概览不可用：${overviewError}`}
          />
        ) : null}
        {overview?.sections.length ? (
          <Flex gap={8} wrap style={{ marginTop: 8 }}>
            {overview.sections.map((section) => (
              <Tag key={section.key} color="processing">
                {section.title} · {section.total}
              </Tag>
            ))}
            {overview.note ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {overview.note}
              </Typography.Text>
            ) : null}
          </Flex>
        ) : null}
      </Card>

      <Tabs
        className="audit-tabs"
        activeKey={tab}
        onChange={(key) => setTab(key as AuditTabKey)}
        aria-label="统一审计分类"
        items={[
          {
            key: "im",
            label: "IM 会话",
            children: (
              <ImAuditView
                key={`im:${workspace}`}
                workspace={workspace || undefined}
                onViewDetails={onViewDetails}
              />
            ),
          },
          {
            key: "query",
            label: "问数",
            children: (
              <QueryAuditSection
                range={queryRange}
                workspace={workspace || undefined}
                revision={revision}
                onViewDetails={onViewDetails}
              />
            ),
          },
          {
            key: "usage",
            label: "用量",
            children: (
              <UsageAuditSection
                range={range}
                workspace={workspace || undefined}
                revision={revision}
                onViewDetails={onViewDetails}
              />
            ),
          },
          {
            key: "mcp",
            label: "MCP 平台",
            children: <McpAuditSection revision={revision} onViewDetails={onViewDetails} />,
          },
        ]}
      />
    </Flex>
  );
}

/** 问数审计：只读调用 observatory 既有接口，不改动其实现。 */
function QueryAuditSection({
  range,
  workspace,
  revision,
  onViewDetails,
}: {
  range: { from?: string; to?: string };
  workspace?: string;
  revision: number;
  onViewDetails: ViewDetails;
}) {
  const [records, setRecords] = useState<QueryAuditSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const viewDetails = (item: QueryAuditSummary) =>
    onViewDetails({ kind: "query", id: item.id, workspace: item.workspace || workspace });

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void fetchQueryAuditSummaries({ ...range, limit: PAGE_SIZE, offset }, workspace)
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
  }, [range, offset, workspace, revision]);

  const columns: ColumnsType<QueryAuditSummary> = [
    {
      title: "时间",
      dataIndex: "startedAt",
      key: "startedAt",
      width: 170,
      render: (value: string) => (
        <Typography.Text style={{ fontSize: 12 }}>
          {new Date(value).toLocaleString()}
        </Typography.Text>
      ),
    },
    {
      title: "问题",
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
      title: "数据源",
      key: "source",
      width: 160,
      render: (_: unknown, item: QueryAuditSummary) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {item.sourceName ?? item.sourceId ?? "默认数据源"}
        </Typography.Text>
      ),
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 90,
      render: (value: QueryAuditStatus) => (
        <Tag color={auditStatusTag(value)}>{AUDIT_STATUS_LABELS[value]}</Tag>
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
    detailColumn(viewDetails),
  ];

  return (
    <Flex vertical gap={12} className="audit-panel">
      {error ? <Alert type="error" showIcon message={error} role="alert" /> : null}
      <Card size="small" className="audit-table-card" styles={{ body: { padding: 0 } }}>
        <Table<QueryAuditSummary>
          size="small"
          rowKey="id"
          columns={columns}
          dataSource={records}
          loading={loading}
          pagination={false}
          scroll={{ x: "max-content", y: "100%" }}
          onRow={(item) => ({ onClick: () => viewDetails(item), className: "audit-log-row" })}
          locale={{ emptyText: <Empty description="暂无问数审计记录" /> }}
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

/** 用量事件：复用主服务 `/api/admin/usage/events`。 */
function UsageAuditSection({
  range,
  workspace,
  revision,
  onViewDetails,
}: {
  range: { from?: number; to?: number };
  workspace?: string;
  revision: number;
  onViewDetails: ViewDetails;
}) {
  const [events, setEvents] = useState<UsageEventRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const viewDetails = (event: UsageEventRecord) => onViewDetails({ kind: "usage", event });

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void fetchUsageEvents({ limit: PAGE_SIZE, workspace })
      .then((next) => {
        if (!active) return;
        // 服务端 `/api/admin/usage/events` 只支持 limit / workspaceId，
        // 时间范围在这里按 createdAt 过滤。
        const from = range.from;
        const to = range.to;
        setEvents(
          next.filter((event) => {
            if (from !== undefined && event.createdAt < from) return false;
            if (to !== undefined && event.createdAt > to) return false;
            return true;
          }),
        );
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
  }, [range, workspace, revision]);

  const columns: ColumnsType<UsageEventRecord> = [
    {
      title: "时间",
      dataIndex: "createdAt",
      key: "createdAt",
      width: 170,
      render: (value: number) => (
        <Typography.Text style={{ fontSize: 12 }}>
          {value ? new Date(value).toLocaleString() : "—"}
        </Typography.Text>
      ),
    },
    {
      title: "类型",
      dataIndex: "kind",
      key: "kind",
      width: 80,
      render: (value: string) => <Tag>{value === "tool" ? "工具" : "对话"}</Tag>,
    },
    {
      title: "来源",
      dataIndex: "source",
      key: "source",
      width: 140,
      render: (value?: string) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {value ?? "—"}
        </Typography.Text>
      ),
    },
    {
      title: "模型 / 工具",
      key: "target",
      render: (_: unknown, item: UsageEventRecord) => (
        <Typography.Text style={{ fontSize: 12 }} ellipsis>
          {item.model ?? item.toolName ?? "—"}
        </Typography.Text>
      ),
    },
    {
      title: "Token",
      key: "tokens",
      width: 110,
      render: (_: unknown, item: UsageEventRecord) => (
        <Typography.Text style={{ fontSize: 12 }}>
          {item.inputTokens} / {item.outputTokens}
        </Typography.Text>
      ),
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 90,
      render: (value: string) => (
        <Badge
          status={value === "ok" ? "success" : value === "error" ? "error" : "warning"}
          text={value}
        />
      ),
    },
    detailColumn(viewDetails),
  ];

  return (
    <Flex vertical gap={12} className="audit-panel">
      {error ? <Alert type="error" showIcon message={error} role="alert" /> : null}
      <Card size="small" className="audit-table-card" styles={{ body: { padding: 0 } }}>
        <Table<UsageEventRecord>
          size="small"
          rowKey="id"
          columns={columns}
          dataSource={events}
          loading={loading}
          pagination={false}
          scroll={{ x: "max-content", y: "100%" }}
          onRow={(item) => ({ onClick: () => viewDetails(item), className: "audit-log-row" })}
          locale={{ emptyText: <Empty description="暂无用量事件" /> }}
        />
      </Card>
    </Flex>
  );
}

/**
 * MCP 平台审计。
 *
 * Control Plane 与 Agent Server 分进程，Control Plane 不可达时只在本 Tab 展示
 * 降级提示，不影响其它 Tab。
 */
function McpAuditSection({
  revision,
  onViewDetails,
}: {
  revision: number;
  onViewDetails: ViewDetails;
}) {
  const [events, setEvents] = useState<AuditEventSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const viewDetails = (item: AuditEventSummary) => onViewDetails({ kind: "mcp", id: item.id });

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void fetchMcpAuditEvents()
      .then((next) => {
        if (active) setEvents(next);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setEvents([]);
        setError(
          `MCP 控制面不可达：${reason instanceof Error ? reason.message : String(reason)}。` +
            "MCP 审计由独立进程提供，其他分类不受影响。",
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [revision]);

  const columns: ColumnsType<AuditEventSummary> = [
    {
      title: "时间",
      dataIndex: "createdAt",
      key: "createdAt",
      width: 170,
      render: (value: string) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {new Date(value).toLocaleString()}
        </Typography.Text>
      ),
    },
    {
      title: "操作者",
      key: "actor",
      width: 160,
      render: (_: unknown, item: AuditEventSummary) => (
        <Flex vertical gap={0}>
          <Typography.Text strong style={{ fontSize: 12 }}>
            {item.actorId}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {item.actorRole}
          </Typography.Text>
        </Flex>
      ),
    },
    {
      title: "动作",
      dataIndex: "action",
      key: "action",
      width: 180,
      render: (value: string) => (
        <Typography.Text code style={{ fontSize: 12 }}>
          {value}
        </Typography.Text>
      ),
    },
    {
      title: "目标",
      dataIndex: "target",
      key: "target",
      ellipsis: true,
      render: (value: string) => (
        <Typography.Text style={{ fontSize: 12 }} ellipsis title={value}>
          {value}
        </Typography.Text>
      ),
    },
    {
      title: "结果",
      dataIndex: "outcome",
      key: "outcome",
      width: 120,
      render: (value: AuditEventSummary["outcome"]) => (
        <Tag color={value === "SUCCEEDED" ? "success" : "error"}>{value}</Tag>
      ),
    },
    {
      title: "耗时",
      dataIndex: "durationMs",
      key: "durationMs",
      width: 90,
      render: (value: number) => (
        <Typography.Text style={{ fontSize: 12 }}>{value}ms</Typography.Text>
      ),
    },
    detailColumn(viewDetails),
  ];

  return (
    <Flex vertical gap={12} className="audit-panel">
      {error ? (
        <Alert
          type="warning"
          showIcon
          message={error}
          role="alert"
          description="MCP 审计由 Control Plane 独立进程提供。"
        />
      ) : null}
      <Card size="small" className="audit-table-card" styles={{ body: { padding: 0 } }}>
        <Table<AuditEventSummary>
          size="small"
          rowKey="id"
          columns={columns}
          dataSource={events}
          loading={loading}
          pagination={false}
          scroll={{ x: "max-content", y: "100%" }}
          onRow={(item) => ({ onClick: () => viewDetails(item), className: "audit-log-row" })}
          locale={{ emptyText: <Empty description="暂无 MCP 审计事件" /> }}
        />
      </Card>
    </Flex>
  );
}
