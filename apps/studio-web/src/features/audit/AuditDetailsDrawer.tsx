import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Collapse,
  Descriptions,
  Drawer,
  Empty,
  Flex,
  Segmented,
  Spin,
  Tag,
  Typography,
} from "antd";
import { ReloadOutlined } from "../../lib/icons.js";
import { UsageTag } from "../../components/UsageTag.js";
import type { AuditEventRecord } from "../mcp/api.js";
import type { QueryAuditDetail } from "../observatory/api.js";
import {
  AUDIT_STATUS_LABELS,
  auditStatusTag,
  formatDuration,
  QueryExecution,
} from "../observatory/QueryExecution.js";
import {
  fetchAuditDetail,
  type AuditDetail,
  type AuditDetailSelection,
  type ImChatAuditDetail,
  type UsageEventRecord,
} from "./api.js";
import {
  chatTypeLabel,
  formatTime,
  platformLabel,
  statusColor,
  statusLabel,
} from "./auditPresentation.js";

const DETAIL_TITLES = {
  im: "IM 会话审计详情",
  query: "问数审计详情",
  usage: "用量事件详情",
  mcp: "MCP 平台审计详情",
};

type SelectAudit = (selection: AuditDetailSelection) => void;

export function AuditDetailsDrawer({
  selection,
  onClose,
  onSelect,
}: {
  selection: AuditDetailSelection | null;
  onClose: () => void;
  onSelect: SelectAudit;
}) {
  const [revision, setRevision] = useState(0);
  const retry = () => setRevision((value) => value + 1);
  const id = selection?.kind === "usage" ? selection.event.id : selection?.id;
  const workspace =
    selection?.kind === "im" || selection?.kind === "query" ? selection.workspace : "";

  return (
    <Drawer
      title={selection ? DETAIL_TITLES[selection.kind] : "审计详情"}
      open={selection !== null}
      onClose={onClose}
      size={760}
      styles={{ wrapper: { maxWidth: "100vw" } }}
      classNames={{ body: "audit-detail-body" }}
      destroyOnHidden
      extra={
        selection && selection.kind !== "usage" ? (
          <Button icon={<ReloadOutlined />} onClick={retry} aria-label="刷新审计详情">
            刷新
          </Button>
        ) : null
      }
    >
      {selection ? (
        <AuditDetailContent
          key={`${selection.kind}:${workspace}:${id}:${revision}`}
          selection={selection}
          onRetry={retry}
          onSelect={onSelect}
        />
      ) : null}
    </Drawer>
  );
}

function AuditDetailContent({
  selection,
  onRetry,
  onSelect,
}: {
  selection: AuditDetailSelection;
  onRetry: () => void;
  onSelect: SelectAudit;
}) {
  const [detail, setDetail] = useState<AuditDetail | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void fetchAuditDetail(selection)
      .then((next) => {
        if (active) setDetail(next);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
    };
  }, [selection]);

  if (error) {
    return (
      <Alert
        type="error"
        showIcon
        role="alert"
        title="审计详情加载失败"
        description={error}
        action={<Button onClick={onRetry}>重试</Button>}
      />
    );
  }
  if (!detail) {
    return (
      <Flex justify="center" style={{ padding: 48 }}>
        <Spin aria-label="正在加载审计详情" />
      </Flex>
    );
  }
  return (
    <Flex vertical gap={16} className="audit-detail">
      {detail.kind === "im" ? <ImDetails record={detail.record} /> : null}
      {detail.kind === "query" ? <QueryDetails detail={detail.detail} onSelect={onSelect} /> : null}
      {detail.kind === "usage" ? <UsageDetails record={detail.record} /> : null}
      {detail.kind === "mcp" ? <McpDetails record={detail.record} /> : null}
    </Flex>
  );
}

function CopyId({ value }: { value: string | null | undefined }) {
  return value ? <Typography.Text copyable>{value}</Typography.Text> : <>—</>;
}

function JsonContent({ value, label }: { value: unknown; label: string }) {
  return value === null || value === undefined ? (
    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={`未记录${label}`} />
  ) : (
    <Typography.Paragraph className="audit-detail__code" aria-label={label} tabIndex={0} copyable>
      {JSON.stringify(value, null, 2)}
    </Typography.Paragraph>
  );
}

function ImDetails({ record }: { record: ImChatAuditDetail }) {
  return (
    <>
      <Descriptions size="small" column={1} bordered>
        <Descriptions.Item label="审计 ID">
          <CopyId value={record.id} />
        </Descriptions.Item>
        <Descriptions.Item label="时间">{formatTime(record.createdAt)}</Descriptions.Item>
        <Descriptions.Item label="状态">
          <Tag color={statusColor(record.status)}>{statusLabel(record.status)}</Tag>
        </Descriptions.Item>
        <Descriptions.Item label="工作区">
          <CopyId value={record.workspace} />
        </Descriptions.Item>
        <Descriptions.Item label="平台">{platformLabel(record.platform) || "—"}</Descriptions.Item>
        <Descriptions.Item label="渠道">
          {record.channelName || "—"} · <CopyId value={record.channelId} />
        </Descriptions.Item>
        <Descriptions.Item label="用户">
          {record.actorName || "—"} · <CopyId value={record.actor} />
        </Descriptions.Item>
        <Descriptions.Item label="会话类型">{chatTypeLabel(record.chatType)}</Descriptions.Item>
        <Descriptions.Item label="会话 ID">
          <CopyId value={record.sessionId} />
        </Descriptions.Item>
        <Descriptions.Item label="平台会话 ID">
          <CopyId value={record.conversationId} />
        </Descriptions.Item>
        <Descriptions.Item label="耗时">{formatDuration(record.durationMs)}</Descriptions.Item>
        <Descriptions.Item label="工具调用数">{record.toolCalls}</Descriptions.Item>
        <Descriptions.Item label="引用数">{record.citationCount}</Descriptions.Item>
      </Descriptions>
      {record.error ? <Alert type="error" showIcon title={record.error} /> : null}
      <Card size="small" title="问题">
        <Typography.Paragraph className="audit-detail__text" copyable={Boolean(record.question)}>
          {record.question || "未记录问题"}
        </Typography.Paragraph>
      </Card>
      <Card size="small" title="回答">
        <Typography.Paragraph className="audit-detail__text" copyable={Boolean(record.answer)}>
          {record.answer || "未记录回答"}
        </Typography.Paragraph>
      </Card>
      {record.tools.length ? (
        <Card size="small" title="调用工具">
          <Flex gap={4} wrap>
            {record.tools.map((tool, index) => (
              <Tag key={`${tool}:${index}`}>{tool}</Tag>
            ))}
          </Flex>
        </Card>
      ) : null}
      {record.citations.length ? (
        <Card size="small" title="引用内容">
          <Flex vertical gap={12}>
            {record.citations.map((citation, index) => (
              <div key={index}>
                <Typography.Text strong>{citation.title || `引用 ${index + 1}`}</Typography.Text>
                {citation.url ? (
                  <Typography.Paragraph className="audit-detail__text" copyable>
                    {citation.url}
                  </Typography.Paragraph>
                ) : null}
                {citation.snippet ? (
                  <Typography.Paragraph className="audit-detail__text">
                    {citation.snippet}
                  </Typography.Paragraph>
                ) : null}
              </div>
            ))}
          </Flex>
        </Card>
      ) : null}
    </>
  );
}

function QueryDetails({ detail, onSelect }: { detail: QueryAuditDetail; onSelect: SelectAudit }) {
  const { record } = detail;
  const viewRelated = (id: string) => onSelect({ kind: "query", id, workspace: record.workspace });
  return (
    <>
      <Descriptions size="small" column={1} bordered>
        <Descriptions.Item label="审计 ID">
          <CopyId value={record.id} />
        </Descriptions.Item>
        <Descriptions.Item label="状态">
          <Tag color={auditStatusTag(record.status)}>{AUDIT_STATUS_LABELS[record.status]}</Tag>
        </Descriptions.Item>
        <Descriptions.Item label="工作区">
          <CopyId value={record.workspace} />
        </Descriptions.Item>
        <Descriptions.Item label="数据源">
          {record.sourceName ?? record.sourceId ?? "默认数据源"}
        </Descriptions.Item>
        <Descriptions.Item label="操作者">{record.actor || "—"}</Descriptions.Item>
        <Descriptions.Item label="入口 / 来源">
          {record.entrypoint} · {record.source} · SQL {record.sqlSource}
        </Descriptions.Item>
        <Descriptions.Item label="开始时间">{formatTime(record.startedAt)}</Descriptions.Item>
        <Descriptions.Item label="结束时间">
          {record.finishedAt ? formatTime(record.finishedAt) : "—"}
        </Descriptions.Item>
        <Descriptions.Item label="耗时">{formatDuration(record.durationMs)}</Descriptions.Item>
        <Descriptions.Item label="模型">{record.model || "—"}</Descriptions.Item>
        <Descriptions.Item label="模型服务">
          <CopyId value={record.providerId} />
        </Descriptions.Item>
        {record.usage ? (
          <Descriptions.Item label="用量">
            <UsageTag usage={record.usage} />
          </Descriptions.Item>
        ) : null}
        <Descriptions.Item label="相关表">
          {record.selectedTables.join("、") || "—"}
        </Descriptions.Item>
        <Descriptions.Item label="结果行数">{record.rowCount ?? "—"}</Descriptions.Item>
      </Descriptions>
      <Card size="small" title="问题">
        <Typography.Paragraph className="audit-detail__text" copyable>
          {record.question}
        </Typography.Paragraph>
        {record.originalQuestion && record.originalQuestion !== record.question ? (
          <Typography.Paragraph className="audit-detail__text" type="secondary">
            原始问题：{record.originalQuestion}
          </Typography.Paragraph>
        ) : null}
      </Card>
      {detail.parent || detail.children.length ? (
        <Flex gap={8} wrap align="center">
          {detail.parent ? (
            <Button onClick={() => viewRelated(detail.parent!.id)}>
              父审计 · {detail.parent.id.slice(0, 8)}
            </Button>
          ) : null}
          {detail.children.map((child) => (
            <Button key={child.id} onClick={() => viewRelated(child.id)}>
              子审计 · {child.id.slice(0, 8)}
            </Button>
          ))}
        </Flex>
      ) : null}
      {record.error ? <Alert type="error" showIcon title={record.error} /> : null}
      {record.clarification || record.clarifying ? (
        <Card size="small" title="澄清信息">
          <Typography.Paragraph className="audit-detail__text">
            {record.clarification?.clarifying || record.clarifying}
          </Typography.Paragraph>
          {record.clarification ? (
            <JsonContent label="澄清详情" value={record.clarification} />
          ) : null}
        </Card>
      ) : null}
      <Card size="small" title="执行过程">
        {record.steps.length ? (
          <QueryExecution steps={record.steps} auditId={record.id} details />
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未记录执行过程" />
        )}
      </Card>
      {[
        { title: "生成 SQL", value: record.generatedSql },
        { title: "执行 SQL", value: record.executedSql || record.sql },
      ].map(({ title, value }) =>
        value ? (
          <Card key={title} size="small" title={title}>
            <Typography.Paragraph className="audit-detail__code" copyable>
              {value}
            </Typography.Paragraph>
          </Card>
        ) : null,
      )}
      <Collapse
        size="small"
        items={[
          ...(record.history.length
            ? [
                {
                  key: "history",
                  label: `查询上下文（${record.history.length} 条）`,
                  children: <JsonContent label="查询上下文" value={record.history} />,
                },
              ]
            : []),
          {
            key: "result",
            label: record.rowCount === null ? "结果预览" : `结果预览 · ${record.rowCount} 行`,
            children: record.resultPreview.length ? (
              <JsonContent label="结果预览" value={record.resultPreview} />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未记录结果预览" />
            ),
          },
        ]}
      />
    </>
  );
}

function UsageDetails({ record }: { record: UsageEventRecord }) {
  return (
    <Descriptions size="small" column={1} bordered>
      <Descriptions.Item label="事件 ID">
        <CopyId value={record.id} />
      </Descriptions.Item>
      <Descriptions.Item label="时间">
        {formatTime(new Date(record.createdAt).toISOString())}
      </Descriptions.Item>
      <Descriptions.Item label="类型">
        {record.kind === "tool" ? "工具调用" : "对话"}
      </Descriptions.Item>
      <Descriptions.Item label="状态">
        <Tag color={statusColor(record.status)}>{statusLabel(record.status)}</Tag>
      </Descriptions.Item>
      <Descriptions.Item label="来源">{record.source || "—"}</Descriptions.Item>
      <Descriptions.Item label="工作区">
        <CopyId value={record.workspaceId} />
      </Descriptions.Item>
      <Descriptions.Item label="会话 ID">
        <CopyId value={record.sessionId} />
      </Descriptions.Item>
      <Descriptions.Item label="模型服务">
        <CopyId value={record.providerId} />
      </Descriptions.Item>
      <Descriptions.Item label="模型">{record.model || "—"}</Descriptions.Item>
      <Descriptions.Item label="工具类型">{record.toolKind || "—"}</Descriptions.Item>
      <Descriptions.Item label="工具名称">{record.toolName || "—"}</Descriptions.Item>
      <Descriptions.Item label="模型请求数">{record.requests ?? "—"}</Descriptions.Item>
      <Descriptions.Item label="输入 Token">{record.inputTokens}</Descriptions.Item>
      <Descriptions.Item label="输出 Token">{record.outputTokens}</Descriptions.Item>
      <Descriptions.Item label="合计 Token">
        {record.inputTokens + record.outputTokens}
      </Descriptions.Item>
      <Descriptions.Item label="工具调用数">{record.toolCalls}</Descriptions.Item>
      <Descriptions.Item label="耗时">{formatDuration(record.durationMs)}</Descriptions.Item>
    </Descriptions>
  );
}

function McpDetails({ record }: { record: AuditEventRecord }) {
  const [payload, setPayload] = useState<"input" | "output" | "context">("input");
  const options: Array<{ value: typeof payload; label: string }> = [
    { value: "input", label: "请求输入" },
    { value: "output", label: "响应输出" },
    { value: "context", label: "执行上下文" },
  ];
  return (
    <>
      <Descriptions size="small" column={1} bordered>
        <Descriptions.Item label="审计 ID">
          <CopyId value={record.id} />
        </Descriptions.Item>
        <Descriptions.Item label="时间">{formatTime(record.createdAt)}</Descriptions.Item>
        <Descriptions.Item label="操作者">
          <CopyId value={record.actorId} />
        </Descriptions.Item>
        <Descriptions.Item label="角色">{record.actorRole}</Descriptions.Item>
        <Descriptions.Item label="来源">
          {record.source === "gateway" ? "MCP Gateway" : "管理控制面"}
        </Descriptions.Item>
        <Descriptions.Item label="动作">{record.action}</Descriptions.Item>
        <Descriptions.Item label="目标">{record.target}</Descriptions.Item>
        <Descriptions.Item label="请求 ID">
          <CopyId value={record.requestId} />
        </Descriptions.Item>
        <Descriptions.Item label="结果">
          <Tag color={record.outcome === "SUCCEEDED" ? "success" : "error"}>
            {record.outcome === "SUCCEEDED" ? "成功" : "失败"}
          </Tag>
        </Descriptions.Item>
        <Descriptions.Item label="HTTP 状态码">{record.statusCode}</Descriptions.Item>
        <Descriptions.Item label="耗时">{formatDuration(record.durationMs)}</Descriptions.Item>
      </Descriptions>
      <Segmented
        aria-label="审计内容类型"
        value={payload}
        onChange={(value) => setPayload(value)}
        options={options}
        block
      />
      <JsonContent
        label={options.find((item) => item.value === payload)!.label}
        value={record[payload]}
      />
    </>
  );
}
