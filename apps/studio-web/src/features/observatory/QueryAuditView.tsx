import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Collapse,
  DatePicker,
  Descriptions,
  Drawer,
  Empty,
  Flex,
  Form,
  Input,
  List,
  Pagination,
  Select,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  AuditOutlined,
  DownloadOutlined,
  ReloadOutlined,
  SearchOutlined,
} from "../../lib/icons.js";
import {
  fetchQueryAuditDetail,
  fetchQueryAudits,
  rerunObservatoryQuery,
  type QueryAuditDetail,
  type QueryAuditSource,
  type QueryAuditRecord,
  type QueryAuditStatus,
  type QueryAuditSummary,
  type QueryEntrypoint,
  type QuerySqlSource,
} from "./api.js";
import { auditExportPath, downloadExport, type ExportFormat } from "./export.js";
import { AUDIT_STATUS_LABELS, auditStatusTag, formatDuration, QueryExecution } from "./QueryExecution.js";
import { UsageTag } from "../../components/UsageTag.js";

const PAGE_SIZE = 20;

const ENTRYPOINTS: Array<{ value: QueryEntrypoint; label: string }> = [
  { value: "observatory", label: "Observatory" },
  { value: "rerun", label: "重跑" },
  { value: "chat", label: "对话" },
  { value: "workflow", label: "工作流" },
  { value: "unknown", label: "历史/未知" },
];

const AUDIT_SOURCES: Array<{ value: QueryAuditSource; label: string }> = [
  { value: "generated", label: "生成" },
  { value: "rerun", label: "重跑" },
  { value: "clarification", label: "澄清" },
  { value: "chat", label: "对话" },
  { value: "workflow", label: "工作流" },
];

const SQL_SOURCES: Array<{ value: QuerySqlSource; label: string }> = [
  { value: "generated", label: "模型生成" },
  { value: "original", label: "原样" },
  { value: "edited", label: "人工编辑" },
];

const STATUS_OPTIONS: Array<{ value: QueryAuditStatus; label: string }> = (
  Object.keys(AUDIT_STATUS_LABELS) as QueryAuditStatus[]
).map((value) => ({ value, label: AUDIT_STATUS_LABELS[value] }));

export function QueryAuditView({ sourceId }: { sourceId: string }) {
  const [records, setRecords] = useState<QueryAuditSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState<QueryAuditStatus | "">("");
  const [entrypoint, setEntrypoint] = useState<QueryEntrypoint | "">("");
  const [auditSource, setAuditSource] = useState<QueryAuditSource | "">("");
  const [sqlSource, setSqlSource] = useState<QuerySqlSource | "">("");
  const [actor, setActor] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState("");
  const [keyword, setKeyword] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [record, setRecord] = useState<QueryAuditRecord | null>(null);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [allSources, setAllSources] = useState(false);
  const [detail, setDetail] = useState<QueryAuditDetail | null>(null);
  const [rerunSql, setRerunSql] = useState("");
  const [rerunning, setRerunning] = useState(false);
  const [rerunNotice, setRerunNotice] = useState("");
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [exportError, setExportError] = useState("");

  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  // 列表与导出共用同一份筛选条件,避免「列表看到的」和「导出的」不一致。
  const filters = useMemo(
    () => ({
      sourceId: allSources ? undefined : sourceId || undefined,
      status: status || undefined,
      actor: actor || undefined,
      entrypoint: entrypoint || undefined,
      source: auditSource || undefined,
      sqlSource: sqlSource || undefined,
      from: from ? new Date(from).toISOString() : undefined,
      to: to ? new Date(to).toISOString() : undefined,
      search: keyword,
    }),
    [sourceId, allSources, status, actor, entrypoint, auditSource, sqlSource, from, to, keyword],
  );
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void fetchQueryAudits({ ...filters, limit: PAGE_SIZE, offset })
      .then((next) => {
        if (active) {
          setRecords(next.records);
          setTotal(next.total);
        }
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

  const exportAudits = async (format: ExportFormat) => {
    if (exporting) return;
    setExporting(format);
    setExportError("");
    try {
      await downloadExport(auditExportPath(filters, format), `query-audits.${format}`);
    } catch (reason) {
      setExportError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setExporting(null);
    }
  };

  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    setRecord(null);
    setDetail(null);
    setDetailError("");
    void fetchQueryAuditDetail(selectedId)
      .then((next) => {
        if (active) {
          const latest =
            next.children
              .filter((child) => child.status === "succeeded")
              .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))[0] ??
            next.record;
          const latestExecution =
            "executedSql" in latest && typeof latest.executedSql === "string"
              ? latest.executedSql
              : null;
          setDetail(next);
          setRecord(next.record);
          setRerunSql(latestExecution || next.record.executedSql || next.record.generatedSql || "");
          setRerunNotice("");
        }
      })
      .catch((reason: unknown) => {
        if (active) setDetailError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
    };
  }, [selectedId, revision]);

  const rerun = async () => {
    if (!record || !rerunSql.trim() || rerunning) return;
    setRerunning(true);
    setRerunNotice("");
    try {
      const result = await rerunObservatoryQuery(record.id, rerunSql);
      setRerunNotice(
        result.error
          ? result.error
          : `已创建子审计 ${result.auditId?.slice(0, 8) ?? "(未知)"}，执行完成`,
      );
      if (result.auditId) {
        setSelectedId(result.auditId);
      }
      refresh();
    } catch (reason) {
      setRerunNotice(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRerunning(false);
    }
  };

  const columns: ColumnsType<QueryAuditSummary> = [
    {
      title: "时间 / 查询 ID",
      dataIndex: "startedAt",
      key: "startedAt",
      width: 170,
      render: (_: unknown, item: QueryAuditSummary) => (
        <Flex vertical gap={0}>
          <Typography.Text style={{ fontSize: 12 }}>{new Date(item.startedAt).toLocaleString()}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }} title={item.id}>
            {item.id.slice(0, 8)}
          </Typography.Text>
        </Flex>
      ),
    },
    {
      title: "问题 / 数据源",
      dataIndex: "question",
      key: "question",
      ellipsis: true,
      render: (_: unknown, item: QueryAuditSummary) => (
        <Flex vertical gap={0} style={{ minWidth: 0 }}>
          <Button type="link" size="small" style={{ padding: 0, textAlign: "left", height: "auto" }} onClick={() => setSelectedId(item.id)}>
            <Typography.Text ellipsis title={item.question} style={{ maxWidth: 260 }}>
              {item.question}
            </Typography.Text>
          </Button>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {item.sourceName ?? item.sourceId ?? "默认数据源"}
          </Typography.Text>
        </Flex>
      ),
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 80,
      render: (value: QueryAuditStatus) => <Tag color={auditStatusTag(value)}>{AUDIT_STATUS_LABELS[value]}</Tag>,
    },
    {
      title: "链路",
      key: "chain",
      width: 170,
      render: (_: unknown, item: QueryAuditSummary) => (
        <Flex vertical gap={4}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {item.entrypoint} · {item.source} · {item.sqlSource}
          </Typography.Text>
          {item.parentAuditId ? (
            <Button
              type="link"
              size="small"
              style={{ padding: 0, height: "auto", fontSize: 12 }}
              onClick={() => setSelectedId(item.parentAuditId)}
            >
              父审计 {item.parentAuditId.slice(0, 8)}
            </Button>
          ) : null}
        </Flex>
      ),
    },
    {
      title: "耗时",
      dataIndex: "durationMs",
      key: "durationMs",
      width: 90,
      render: (value: number) => <Typography.Text style={{ fontSize: 12 }}>{formatDuration(value)}</Typography.Text>,
    },
    {
      title: "行数",
      dataIndex: "rowCount",
      key: "rowCount",
      width: 70,
      render: (value: number | null) => value ?? "—",
    },
  ];

  return (
    <Flex vertical gap={12}>
      <Card size="small">
        <Form layout="inline" onFinish={() => {
          setKeyword(search.trim());
          setOffset(0);
          refresh();
        }} style={{ rowGap: 8, flexWrap: "wrap" }}>
          <Form.Item style={{ marginBottom: 0, minWidth: 220, flex: 1 }}>
            <Input.Search
              aria-label="搜索审计日志"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onSearch={(value) => {
                setKeyword(value.trim());
                setOffset(0);
                refresh();
              }}
              placeholder="搜索问题或查询 ID"
              allowClear
            />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <Select
              aria-label="审计数据源范围"
              value={allSources ? "all" : "current"}
              onChange={(value) => {
                setAllSources(value === "all");
                setOffset(0);
                setSelectedId(null);
                setRecord(null);
              }}
              options={[
                { value: "current", label: "当前数据源" },
                { value: "all", label: "全部数据源" },
              ]}
              style={{ width: 130 }}
            />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <Select
              aria-label="审计执行状态"
              value={status}
              onChange={(value) => {
                setStatus(value as QueryAuditStatus | "");
                setOffset(0);
              }}
              options={[{ value: "", label: "全部状态" }, ...STATUS_OPTIONS.map((item) => ({ value: item.value as string, label: item.label }))]}
              style={{ width: 120 }}
            />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <Select
              aria-label="审计入口"
              value={entrypoint}
              onChange={(value) => {
                setEntrypoint(value as QueryEntrypoint | "");
                setOffset(0);
              }}
              options={[{ value: "", label: "全部入口" }, ...ENTRYPOINTS.map((item) => ({ value: item.value as string, label: item.label }))]}
              style={{ width: 130 }}
            />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <Select
              aria-label="审计来源"
              value={auditSource}
              onChange={(value) => {
                setAuditSource(value as QueryAuditSource | "");
                setOffset(0);
              }}
              options={[{ value: "", label: "全部来源" }, ...AUDIT_SOURCES.map((item) => ({ value: item.value as string, label: item.label }))]}
              style={{ width: 120 }}
            />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <Select
              aria-label="SQL 来源"
              value={sqlSource}
              onChange={(value) => {
                setSqlSource(value as QuerySqlSource | "");
                setOffset(0);
              }}
              options={[{ value: "", label: "全部 SQL 来源" }, ...SQL_SOURCES.map((item) => ({ value: item.value as string, label: item.label }))]}
              style={{ width: 140 }}
            />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <Input
              aria-label="审计 actor"
              value={actor}
              onChange={(event) => setActor(event.target.value.trim())}
              placeholder="actor 指纹"
              style={{ width: 130 }}
            />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <DatePicker
              showTime
              placeholder="从"
              aria-label="审计开始时间"
              onChange={(value) => {
                setFrom(value ? value.toISOString() : "");
                setOffset(0);
              }}
            />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <DatePicker
              showTime
              placeholder="至"
              aria-label="审计结束时间"
              onChange={(value) => {
                setTo(value ? value.toISOString() : "");
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
                <Button icon={<ReloadOutlined />} onClick={refresh} aria-label="刷新审计日志" />
              </Tooltip>
              <Button
                icon={<DownloadOutlined />}
                loading={exporting === "csv"}
                disabled={exporting !== null}
                onClick={() => void exportAudits("csv")}
              >
                {exporting === "csv" ? "导出中..." : "导出 CSV"}
              </Button>
              <Button
                icon={<DownloadOutlined />}
                loading={exporting === "json"}
                disabled={exporting !== null}
                onClick={() => void exportAudits("json")}
              >
                {exporting === "json" ? "导出中..." : "导出 JSON"}
              </Button>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>{total} 条记录</Typography.Text>
            </Flex>
          </Form.Item>
        </Form>
      </Card>
      {error ? <Alert type="error" showIcon message={error} role="alert" /> : null}
      {exportError ? <Alert type="error" showIcon message={`导出失败：${exportError}`} role="alert" /> : null}
      <Flex gap={12} align="flex-start">
        <Card
          size="small"
          style={{ flex: 1, minWidth: 0 }}
          styles={{ body: { padding: 0 } }}
        >
          <Table<QueryAuditSummary>
            size="small"
            rowKey="id"
            columns={columns}
            dataSource={records}
            loading={loading}
            pagination={false}
            scroll={{ x: "max-content" }}
            onRow={(item) => ({
              onClick: () => setSelectedId(item.id),
              style: {
                cursor: "pointer",
                background: selectedId === item.id ? "var(--studio-selected)" : undefined,
              },
            })}
            locale={{ emptyText: <Empty description="暂无匹配的查询记录" /> }}
          />
          <Flex justify="flex-end" style={{ padding: 12 }}>
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
      <Drawer
        title="查询详情"
        open={selectedId !== null}
        onClose={() => {
          setSelectedId(null);
          setRecord(null);
          setDetail(null);
        }}
        width={640}
        destroyOnClose={false}
        extra={<AuditOutlined />}
      >
        {detailError ? <Alert type="error" showIcon message={detailError} role="alert" style={{ marginBottom: 12 }} /> : null}
        {!record ? (
          selectedId && !detailError ? (
            <Flex justify="center" style={{ padding: 48 }}>
              <Spin aria-label="正在加载详情" />
            </Flex>
          ) : (
            <Empty description="选择一条记录查看执行过程" />
          )
        ) : (
          <Flex vertical gap={12}>
            <Flex gap={8} align="center" wrap>
              <Typography.Title level={5} style={{ margin: 0, flex: 1 }}>{record.question}</Typography.Title>
              <Tag color={auditStatusTag(record.status)}>{AUDIT_STATUS_LABELS[record.status]}</Tag>
            </Flex>
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="数据源">{record.sourceName ?? record.sourceId ?? "默认数据源"}</Descriptions.Item>
              <Descriptions.Item label="Actor">
                <Typography.Text ellipsis title={record.actor} style={{ maxWidth: 360 }}>
                  {record.actor} · {record.actorType === "legacy" ? "历史记录" : "部署 operator"}
                </Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="入口 / 来源">
                {record.entrypoint} · {record.source} · SQL {record.sqlSource}
              </Descriptions.Item>
              <Descriptions.Item label="原始问题">{record.originalQuestion || record.question}</Descriptions.Item>
              <Descriptions.Item label="总耗时">{formatDuration(record.durationMs)}</Descriptions.Item>
              <Descriptions.Item label="模型">{record.model ?? "—"}</Descriptions.Item>
              {record.usage ? (
                <Descriptions.Item label="用量"><UsageTag usage={record.usage} /></Descriptions.Item>
              ) : null}
              <Descriptions.Item label="Provider">{record.providerId ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="相关表">{record.selectedTables.join("、") || "—"}</Descriptions.Item>
              <Descriptions.Item label="开始时间">{new Date(record.startedAt).toLocaleString()}</Descriptions.Item>
              <Descriptions.Item label="结束时间">
                {record.finishedAt ? new Date(record.finishedAt).toLocaleString() : "执行中"}
              </Descriptions.Item>
            </Descriptions>
            {detail?.parent ? (
              <Typography.Paragraph style={{ fontSize: 12, marginBottom: 0 }}>
                父审计：
                <Button type="link" size="small" style={{ padding: 0, height: "auto" }} onClick={() => setSelectedId(detail.parent!.id)}>
                  {detail.parent.id.slice(0, 8)}
                </Button>
              </Typography.Paragraph>
            ) : null}
            {detail?.children.length ? (
              <Flex gap={4} wrap align="center">
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>子审计：</Typography.Text>
                {detail.children.map((child) => (
                  <Button key={child.id} type="link" size="small" style={{ padding: "0 4px", height: "auto" }} onClick={() => setSelectedId(child.id)}>
                    {child.id.slice(0, 8)}
                  </Button>
                ))}
              </Flex>
            ) : null}
            {record.error ? <Alert type="error" showIcon message={record.error} /> : null}
            {record.clarification ? (
              <Card size="small" title={`第 ${record.clarification.round} 轮 · 待补充：${record.clarification.slots.map((slot) => slot.label).join("、")}`}>
                <Typography.Paragraph style={{ fontSize: 12 }}>{record.clarification.clarifying}</Typography.Paragraph>
                {record.clarification.candidates.length ? (
                  <Flex gap={4} wrap>
                    {record.clarification.candidates.map((candidate) => (
                      <Tag key={`${candidate.label}:${candidate.value}`}>{candidate.label}</Tag>
                    ))}
                  </Flex>
                ) : null}
              </Card>
            ) : record.clarifying ? (
              <Typography.Paragraph>{record.clarifying}</Typography.Paragraph>
            ) : null}
            {record.history.length ? (
              <Collapse
                size="small"
                items={[
                  {
                    key: "history",
                    label: `查询上下文（${record.history.length} 条）`,
                    children: (
                      <List
                        size="small"
                        dataSource={record.history}
                        renderItem={(turn) => (
                          <List.Item>
                            <Typography.Paragraph style={{ fontSize: 12, marginBottom: 0 }}>
                              <b>{turn.role === "user" ? "用户：" : "助手："}</b>
                              {turn.content}
                            </Typography.Paragraph>
                          </List.Item>
                        )}
                      />
                    ),
                  },
                ]}
              />
            ) : null}
            <Card size="small" title="执行过程">
              <QueryExecution steps={record.steps} auditId={record.id} details />
            </Card>
            {record.sql ? (
              <Card size="small" title="SQL">
                <Typography.Paragraph code style={{ fontSize: 12 }}>{record.sql}</Typography.Paragraph>
              </Card>
            ) : null}
            <Card size="small" title="基于此审计重跑">
              <Flex vertical gap={8}>
                <Input.TextArea
                  aria-label="审计重跑 SQL"
                  value={rerunSql}
                  onChange={(event) => setRerunSql(event.target.value)}
                  placeholder="仅允许单条只读 SELECT，服务端会重新校验"
                  rows={4}
                  spellCheck={false}
                />
                <Flex gap={8}>
                  <Button
                    disabled={
                      rerunning ||
                      Boolean(record.parentAuditId) ||
                      !(record.executedSql ?? record.generatedSql)
                    }
                    onClick={() => setRerunSql(record.executedSql ?? record.generatedSql ?? "")}
                  >
                    恢复执行 SQL
                  </Button>
                  <Button
                    type="primary"
                    loading={rerunning}
                    disabled={rerunning || Boolean(record.parentAuditId) || !rerunSql.trim()}
                    onClick={() => void rerun()}
                  >
                    {rerunning ? "重跑中..." : "创建子审计并重跑"}
                  </Button>
                </Flex>
                {rerunNotice ? <Alert showIcon type="info" message={rerunNotice} /> : null}
              </Flex>
            </Card>
            {record.rowCount !== null ? (
              <Collapse
                size="small"
                items={[
                  {
                    key: "preview",
                    label: `结果预览 · ${record.rowCount} 行`,
                    children: (
                      <Typography.Paragraph code style={{ fontSize: 12 }}>
                        {JSON.stringify(record.resultPreview, null, 2)}
                      </Typography.Paragraph>
                    ),
                  },
                ]}
              />
            ) : null}
          </Flex>
        )}
      </Drawer>
    </Flex>
  );
}
