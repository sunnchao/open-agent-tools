import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Empty,
  Flex,
  Select,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { BarChartOutlined, ReloadOutlined } from "../../lib/icons.js";
import {
  getToolSla,
  type McpService,
  type ServiceSlaStat,
  type SlaWindow,
  type ToolSlaReport,
  type ToolSlaStat,
} from "./api.js";

function formatPercent(value: number): string {
  return `${Math.round(value * 1_000) / 10}%`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

const toolColumns: ColumnsType<ToolSlaStat> = [
  {
    title: "工具",
    dataIndex: "toolName",
    key: "toolName",
    render: (_: unknown, tool: ToolSlaStat) => (
      <Flex vertical gap={0}>
        <Typography.Text strong>{tool.toolName}</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          max {tool.maxDurationMs}ms
        </Typography.Text>
      </Flex>
    ),
  },
  {
    title: "调用",
    dataIndex: "calls",
    key: "calls",
    width: 130,
    render: (_: unknown, tool: ToolSlaStat) => (
      <Flex vertical gap={0}>
        <Typography.Text strong>{tool.calls}</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {tool.succeeded} 成功 / {tool.failed} 失败
        </Typography.Text>
      </Flex>
    ),
  },
  {
    title: "成功率",
    dataIndex: "successRate",
    key: "successRate",
    width: 130,
    render: (_: unknown, tool: ToolSlaStat) => (
      <Flex vertical gap={0}>
        <Typography.Text strong style={{ color: tool.failed === 0 ? "#2f9e6e" : "#d64545" }}>
          {formatPercent(tool.successRate)}
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {tool.failed === 0 ? "无失败" : `${tool.failed} 次失败`}
        </Typography.Text>
      </Flex>
    ),
  },
  {
    title: "时延",
    key: "latency",
    width: 150,
    render: (_: unknown, tool: ToolSlaStat) => (
      <Flex vertical gap={0}>
        <Typography.Text strong>P95 {tool.p95DurationMs}ms</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          P50 {tool.p50DurationMs}ms
        </Typography.Text>
      </Flex>
    ),
  },
  {
    title: "错误 Top",
    key: "topError",
    width: 200,
    render: (_: unknown, tool: ToolSlaStat) => {
      const topError = tool.errors[0];
      return (
        <Flex vertical gap={0}>
          <Typography.Text strong ellipsis title={topError?.message} style={{ maxWidth: 180 }}>
            {topError ? topError.code : "窗口内无错误"}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>
            {topError ? `${topError.message} ×${topError.count}` : "—"}
          </Typography.Text>
        </Flex>
      );
    },
  },
  {
    title: "最近一次失败原因",
    key: "lastFailure",
    render: (_: unknown, tool: ToolSlaStat) => (
      <Flex vertical gap={0}>
        <Typography.Text ellipsis title={tool.lastFailure?.message} style={{ maxWidth: 240 }}>
          {tool.lastFailure ? tool.lastFailure.message : "窗口内没有失败"}
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {tool.lastFailure
            ? `${tool.lastFailure.code} · HTTP ${tool.lastFailure.statusCode} · ${formatTime(
                tool.lastFailure.createdAt,
              )}`
            : "—"}
        </Typography.Text>
      </Flex>
    ),
  },
];

function ServiceSlaSection({ service }: { service: ServiceSlaStat }) {
  return (
    <Card
      size="small"
      title={`/${service.serviceSlug}`}
      extra={
        <Tag>
          {formatPercent(service.successRate)} · P95 {service.p95DurationMs}ms · {service.calls} 次调用
        </Tag>
      }
      styles={{ body: { padding: 0 } }}
    >
      <Table<ToolSlaStat>
        size="small"
        rowKey="toolName"
        columns={toolColumns}
        dataSource={service.tools}
        pagination={false}
        scroll={{ x: "max-content" }}
        locale={{ emptyText: <Empty description="暂无工具数据" /> }}
      />
    </Card>
  );
}

export function SlaPanel({ services = [] }: { services?: McpService[] }) {
  const [range, setRange] = useState<SlaWindow>("24h");
  const [serviceSlug, setServiceSlug] = useState("");
  const [report, setReport] = useState<ToolSlaReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReport(await getToolSla({ window: range, ...(serviceSlug ? { serviceSlug } : {}) }));
      setError("");
    } catch (reason) {
      setReport(null);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [range, serviceSlug]);

  useEffect(() => void load(), [load]);

  const hasData = report !== null && report.services.length > 0;

  return (
    <Flex vertical gap={12}>
      <Card size="small">
        <Flex gap={12} align="center" wrap>
          <Flex vertical gap={0}>
            <Typography.Text strong>工具 SLA</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {report
                ? `${range} 窗口 · 共 ${report.totals.calls} 次工具调用 · 成功率 ${formatPercent(
                    report.totals.successRate,
                  )}`
                : "聚合 Gateway 工具调用审计事件"}
            </Typography.Text>
          </Flex>
          <Flex gap={8} align="center" wrap style={{ marginLeft: "auto" }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>窗口</Typography.Text>
            <Select
              aria-label="窗口"
              value={range}
              onChange={(value) => setRange(value)}
              options={[
                { value: "24h", label: "最近 24 小时" },
                { value: "7d", label: "最近 7 天" },
              ]}
              style={{ width: 140 }}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>服务</Typography.Text>
            <Select
              aria-label="服务"
              value={serviceSlug || undefined}
              onChange={(value) => setServiceSlug(value ?? "")}
              placeholder="全部服务"
              allowClear
              options={services.map((service) => ({
                value: service.slug,
                label: `${service.name} /${service.slug}`,
              }))}
              style={{ minWidth: 180 }}
            />
            <Tooltip title="刷新">
              <Button icon={<ReloadOutlined spin={loading} />} onClick={() => void load()} aria-label="刷新" />
            </Tooltip>
          </Flex>
        </Flex>
      </Card>

      {error ? <Alert type="error" showIcon message={`SLA 数据加载失败：${error}`} role="status" /> : null}

      {loading ? (
        <Flex justify="center" style={{ padding: 48 }}>
          <Spin aria-label="正在聚合工具调用审计事件" />
        </Flex>
      ) : !hasData ? (
        <Empty
          description="窗口内没有工具调用记录"
        />
      ) : null}

      {!loading && hasData && (report as ToolSlaReport).scan.truncated ? (
        <Alert
          showIcon
          type="info"
          message={`统计仅覆盖最近 ${(report as ToolSlaReport).scan.limit} 条工具调用审计事件（已截断），更早的调用未纳入本次窗口。`}
        />
      ) : null}

      {!loading && hasData
        ? (report as ToolSlaReport).services.map((service) => (
            <ServiceSlaSection key={service.serviceSlug} service={service} />
          ))
        : null}
      {!loading && !hasData && !error ? (
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          <BarChartOutlined /> 只有 Gateway 收到 tools/call 请求后才会产生审计事件；请确认已有客户端携带 API Key
          调用过已发布版本。
        </Typography.Paragraph>
      ) : null}
    </Flex>
  );
}
