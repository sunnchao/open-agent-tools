import { useCallback, useEffect, useMemo, useState } from "react";
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
  List,
  Modal,
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
  DeleteOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
} from "../../lib/icons.js";
import { StudioPage } from "../../components/studio/StudioPageHeader.js";
import { StudioNotice, type StudioNoticeValue } from "../../components/studio/StudioNotice.js";
import {
  createReport,
  deleteReport,
  listReports,
  listReportRuns,
  listSchemaSources,
  runReportNow,
  updateReport,
  type ReportDraft,
  type ReportRun,
  type ScheduledReport,
  type SchemaSourceOption,
} from "./api.js";
import {
  REPORT_STATUS_LABELS,
  WEEKDAY_LABELS,
  describeSchedule,
  formatCellValue,
  formatDateTime,
  formatDuration,
  isValidTimeOfDay,
} from "./schedule.js";

type Notice = StudioNoticeValue;

function emptyDraft(): ReportDraft {
  return {
    name: "",
    question: "",
    sourceId: null,
    frequency: "daily",
    time: "09:00",
    weekday: 1,
    enabled: true,
  };
}

function draftFromReport(report: ScheduledReport): ReportDraft {
  return {
    name: report.name,
    question: report.question,
    sourceId: report.sourceId,
    frequency: report.schedule.frequency,
    time: report.schedule.time,
    weekday: report.schedule.weekday ?? 1,
    enabled: report.enabled,
  };
}

function runTagColor(status: ReportRun["status"]): string {
  if (status === "succeeded") return "success";
  if (status === "failed") return "error";
  if (status === "clarifying") return "warning";
  return "processing";
}

export function ReportsWorkspace() {
  const { message } = App.useApp();
  const [reports, setReports] = useState<ScheduledReport[]>([]);
  const [sources, setSources] = useState<SchemaSourceOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ReportDraft | null>(null);
  const [runs, setRuns] = useState<ReportRun[]>([]);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "run" | "delete" | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const loadRuns = useCallback(async (reportId: string) => {
    const body = await listReportRuns(reportId, 20);
    setRuns(body.runs);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [list, schemaSources] = await Promise.all([listReports(), listSchemaSources()]);
      setReports(list.reports);
      setSources(schemaSources);
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "加载失败" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const select = (report: ScheduledReport) => {
    setSelectedId(report.id);
    setDraft(draftFromReport(report));
    setOpenRunId(null);
    void loadRuns(report.id).catch(() => setRuns([]));
  };

  const startNew = () => {
    setSelectedId(null);
    setDraft(emptyDraft());
    setRuns([]);
    setOpenRunId(null);
    setNotice(null);
  };

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim() || !draft.question.trim()) {
      setNotice({ type: "error", text: "名称与问题都不能为空" });
      return;
    }
    if (!isValidTimeOfDay(draft.time)) {
      setNotice({ type: "error", text: "时间必须是 HH:MM(24 小时制)" });
      return;
    }
    setBusy("save");
    setNotice(null);
    try {
      const saved = selectedId
        ? (await updateReport(selectedId, draft)).report
        : (await createReport(draft)).report;
      await refresh();
      setSelectedId(saved.id);
      setDraft(draftFromReport(saved));
      await loadRuns(saved.id);
      void message.success(selectedId ? "报表已更新" : "报表已创建");
      setNotice({ type: "success", text: selectedId ? "报表已更新" : "报表已创建" });
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "保存失败" });
    } finally {
      setBusy(null);
    }
  };

  const runNow = async () => {
    if (!selectedId) return;
    setBusy("run");
    setNotice(null);
    try {
      const { run } = await runReportNow(selectedId);
      await Promise.all([refresh(), loadRuns(selectedId)]);
      setOpenRunId(run.id);
      const text =
        run.status === "succeeded"
          ? `已运行,返回 ${run.rowCount ?? 0} 行`
          : `运行未成功:${run.error ?? run.status}`;
      if (run.status === "succeeded") {
        void message.success(text);
        setNotice({ type: "success", text });
      } else {
        setNotice({ type: "error", text });
      }
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "运行失败" });
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!selectedId) return;
    setBusy("delete");
    setNotice(null);
    try {
      await deleteReport(selectedId);
      startNew();
      await refresh();
      void message.success("报表已删除");
      setNotice({ type: "success", text: "报表已删除" });
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "删除失败" });
    } finally {
      setBusy(null);
    }
  };

  const openRun = runs.find((run) => run.id === openRunId) ?? null;
  const nextRunHint =
    draft && draft.enabled
      ? isValidTimeOfDay(draft.time)
        ? `下次运行:${describeSchedule({
            frequency: draft.frequency,
            time: draft.time,
            weekday: draft.weekday,
          })}`
        : "请先填写合法的时间点"
      : "已停用,不会自动执行";

  const runColumns: ColumnsType<ReportRun> = useMemo(
    () => [
      {
        title: "开始时间",
        dataIndex: "startedAt",
        key: "startedAt",
        render: (value: string) => (
          <Typography.Text type="secondary">{formatDateTime(value)}</Typography.Text>
        ),
      },
      {
        title: "触发",
        dataIndex: "trigger",
        key: "trigger",
        render: (value: ReportRun["trigger"]) => (value === "manual" ? "手动" : "定时"),
      },
      {
        title: "状态",
        dataIndex: "status",
        key: "status",
        render: (value: ReportRun["status"]) => (
          <Tag color={runTagColor(value)}>{REPORT_STATUS_LABELS[value]}</Tag>
        ),
      },
      {
        title: "耗时",
        dataIndex: "durationMs",
        key: "durationMs",
        render: (value: number) => (
          <Typography.Text type="secondary">{formatDuration(value)}</Typography.Text>
        ),
      },
      {
        title: "行数",
        dataIndex: "rowCount",
        key: "rowCount",
        render: (value: number | null) => value ?? "—",
      },
      {
        title: "操作",
        key: "actions",
        render: (_: unknown, record: ReportRun) => (
          <Button type="link" size="small" onClick={() => setOpenRunId(record.id)}>
            查看详情
          </Button>
        ),
      },
    ],
    [],
  );

  const previewColumns: ColumnsType<Record<string, unknown>> = useMemo(() => {
    if (!openRun || openRun.columns.length === 0) return [];
    return openRun.columns.map((column) => ({
      title: column,
      dataIndex: column,
      key: column,
      ellipsis: true,
      render: (value: unknown) => formatCellValue(value),
    }));
  }, [openRun]);

  const enabledCount = reports.filter((item) => item.enabled).length;

  return (
    <StudioPage
      eyebrow="Scheduled Reports"
      title="定时报表"
      description="把问数变成周期报表,保存后按周期自动执行。"
      actions={
        <>
          <Badge
            status={enabledCount > 0 ? "success" : "default"}
            text={`${enabledCount} 个启用`}
          />
          <Button
            icon={<ReloadOutlined />}
            disabled={loading}
            onClick={() => {
              setNotice(null);
              void refresh();
            }}
          >
            刷新
          </Button>
          <Button icon={<PlusOutlined />} type="primary" onClick={startNew}>
            新建报表
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
          title="报表清单"
          extra={<Tag>{reports.length}</Tag>}
          style={{ width: 280, flex: "0 0 auto", maxHeight: "100%", overflow: "hidden" }}
          styles={{ body: { padding: 8, overflowY: "auto", maxHeight: "calc(100% - 57px)" } }}
        >
          {loading ? (
            <Flex justify="center" style={{ padding: 24 }}>
              <Spin aria-label="正在加载报表" />
            </Flex>
          ) : reports.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="还没有定时报表,点「新建报表」保存一次问数"
            />
          ) : (
            <List
              size="small"
              dataSource={reports}
              rowKey="id"
              renderItem={(report) => (
                <List.Item
                  onClick={() => select(report)}
                  style={{
                    cursor: "pointer",
                    borderRadius: 8,
                    padding: "8px 10px",
                    background: report.id === selectedId ? "var(--studio-selected)" : undefined,
                  }}
                >
                  <List.Item.Meta
                    avatar={<Badge status={report.enabled ? "success" : "default"} />}
                    title={
                      <Typography.Text strong ellipsis style={{ maxWidth: 170 }}>
                        {report.name}
                      </Typography.Text>
                    }
                    description={`${describeSchedule(report.schedule)} · ${
                      report.enabled ? `下次 ${formatDateTime(report.nextRunAt)}` : "已停用"
                    }`}
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
          style={{ flex: 1, minWidth: 0, minHeight: 0, alignSelf: "stretch", overflowY: "auto" }}
        >
          {draft ? (
            <Card
              size="small"
              title={selectedId ? "编辑报表" : "新建报表"}
              extra={
                <Tag color={selectedId ? "success" : "processing"}>
                  {selectedId ? `已保存 · ID ${selectedId.slice(0, 8)}` : "未保存"}
                </Tag>
              }
            >
              <Form layout="vertical" onFinish={() => void save()}>
                <Form.Item label={`名称 (${draft.name.length}/120)`} required>
                  <Input
                    aria-label="报表名称"
                    value={draft.name}
                    maxLength={120}
                    placeholder="例如:每日活跃用户"
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                </Form.Item>
                <Form.Item label={`自然语言问题 (${draft.question.length}/2000)`} required>
                  <Input.TextArea
                    aria-label="自然语言问题"
                    rows={3}
                    value={draft.question}
                    maxLength={2000}
                    placeholder="例如:昨天的活跃用户有多少?"
                    onChange={(event) => setDraft({ ...draft, question: event.target.value })}
                  />
                </Form.Item>
                <Form.Item label="数据源">
                  <Select
                    aria-label="数据源"
                    value={draft.sourceId ?? ""}
                    onChange={(value) => setDraft({ ...draft, sourceId: value || null })}
                    options={[
                      { value: "", label: "默认数据源" },
                      ...sources.map((source) => ({
                        value: source.id,
                        label: `${source.name}${source.isDefault ? "(默认)" : ""}`,
                      })),
                    ]}
                  />
                </Form.Item>
                <Flex gap={12} wrap>
                  <Form.Item label="周期" style={{ flex: 1, minWidth: 140 }}>
                    <Select
                      aria-label="周期"
                      value={draft.frequency}
                      onChange={(value) =>
                        setDraft({ ...draft, frequency: value === "weekly" ? "weekly" : "daily" })
                      }
                      options={[
                        { value: "daily", label: "每天" },
                        { value: "weekly", label: "每周" },
                      ]}
                    />
                  </Form.Item>
                  <Form.Item
                    label="时间"
                    style={{ flex: 1, minWidth: 140 }}
                    validateStatus={isValidTimeOfDay(draft.time) ? undefined : "error"}
                    help={isValidTimeOfDay(draft.time) ? undefined : "时间必须是 HH:MM(24 小时制)"}
                  >
                    <Input
                      aria-label="时间"
                      type="time"
                      value={draft.time}
                      onChange={(event) => setDraft({ ...draft, time: event.target.value })}
                    />
                  </Form.Item>
                  {draft.frequency === "weekly" ? (
                    <Form.Item label="星期" style={{ flex: 1, minWidth: 140 }}>
                      <Select
                        aria-label="星期"
                        value={String(draft.weekday)}
                        onChange={(value) => setDraft({ ...draft, weekday: Number(value) })}
                        options={WEEKDAY_LABELS.map((label, index) => ({
                          value: String(index),
                          label,
                        }))}
                      />
                    </Form.Item>
                  ) : null}
                  <Form.Item label="启用自动执行" style={{ flex: 1, minWidth: 140 }}>
                    <Switch
                      aria-label="启用自动执行"
                      checked={draft.enabled}
                      onChange={(checked) => setDraft({ ...draft, enabled: checked })}
                    />
                  </Form.Item>
                </Flex>
                <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
                  {nextRunHint}
                </Typography.Paragraph>
                <Flex gap={8} justify="flex-end" wrap>
                  <Button
                    type="primary"
                    htmlType="submit"
                    icon={<SaveOutlined />}
                    loading={busy === "save"}
                    disabled={busy !== null && busy !== "save"}
                  >
                    保存
                  </Button>
                  {selectedId ? (
                    <Button
                      icon={<PlayCircleOutlined />}
                      loading={busy === "run"}
                      disabled={busy !== null}
                      onClick={() => void runNow()}
                    >
                      立即运行一次
                    </Button>
                  ) : null}
                  {selectedId ? (
                    <Popconfirm
                      title="删除这个定时报表?"
                      description="运行历史会一并清理,该操作不可恢复。"
                      okText="确认删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => void remove()}
                    >
                      <Button
                        danger
                        icon={<DeleteOutlined />}
                        disabled={busy !== null}
                        aria-label="删除报表"
                      >
                        删除
                      </Button>
                    </Popconfirm>
                  ) : null}
                </Flex>
              </Form>
            </Card>
          ) : (
            <Card size="small">
              <Empty description="选择一个报表,或新建一个把问数变成周期报表。" />
            </Card>
          )}

          {selectedId ? (
            <Card size="small" title="运行历史" extra={<Tag>{runs.length}</Tag>}>
              <Table<ReportRun>
                size="small"
                rowKey="id"
                columns={runColumns}
                dataSource={runs}
                pagination={runs.length > 10 ? { pageSize: 10, showSizeChanger: false } : false}
                scroll={{ x: "max-content" }}
                locale={{ emptyText: <Empty description="还没有运行记录" /> }}
              />
            </Card>
          ) : null}
        </Flex>
      </Flex>
      <Modal
        centered
        width={960}
        title={
          openRun ? (
            <Flex gap={8} align="center" wrap>
              <span>运行详情</span>
              <Tag color={runTagColor(openRun.status)}>{REPORT_STATUS_LABELS[openRun.status]}</Tag>
              <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
                {formatDateTime(openRun.startedAt)} · {formatDuration(openRun.durationMs)} ·{" "}
                {openRun.rowCount ?? 0} 行
              </Typography.Text>
            </Flex>
          ) : (
            "运行详情"
          )
        }
        open={openRun !== null}
        onCancel={() => setOpenRunId(null)}
        footer={
          <Button type="primary" onClick={() => setOpenRunId(null)}>
            关闭
          </Button>
        }
        destroyOnHidden
        styles={{
          body: {
            maxHeight: "min(70vh, 720px)",
            overflow: "auto",
            overscrollBehavior: "contain",
          },
        }}
      >
        {openRun ? (
          <Flex vertical gap={10}>
            {openRun.error ? <Alert type="error" showIcon message={openRun.error} /> : null}
            {openRun.sql ? (
              <Typography.Paragraph code copyable style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                {openRun.sql}
              </Typography.Paragraph>
            ) : null}
            {openRun.checks.length > 0 ? (
              <Flex vertical gap={4}>
                {openRun.checks.map((check) => (
                  <Alert
                    key={`${check.code}-${check.message}`}
                    type={check.level === "warning" ? "warning" : "info"}
                    showIcon
                    message={check.message}
                  />
                ))}
              </Flex>
            ) : null}
            {openRun.columns.length > 0 ? (
              <>
                <Table<Record<string, unknown>>
                  size="small"
                  rowKey={(_, index) => String(index)}
                  columns={previewColumns}
                  dataSource={openRun.preview.map((row, index) => ({
                    ...row,
                    key: `${index}:${JSON.stringify(row)}`,
                  }))}
                  pagination={
                    openRun.preview.length > 10 ? { pageSize: 10, showSizeChanger: false } : false
                  }
                />
                {openRun.truncated ? (
                  <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
                    结果已截断,仅保留前 {openRun.preview.length} 行快照
                  </Typography.Paragraph>
                ) : null}
              </>
            ) : (
              <Empty description="本次运行没有返回数据" />
            )}
          </Flex>
        ) : null}
      </Modal>
    </StudioPage>
  );
}
