import { Alert, Card, Table, Tag } from "antd";
import type { SqlResultProps } from "../types.js";
import { QueryExecution, formatDuration } from "../features/observatory/QueryExecution.js";
import { UsageTag } from "./UsageTag.js";

export function SqlResultCard({
  rows,
  sourceName,
  sql,
  auditId,
  steps,
  durationMs,
  truncated,
  clarifying,
  usage,
}: SqlResultProps) {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))].map((key) => ({
    title: key,
    dataIndex: ["values", key],
    key,
    render: (value: unknown) =>
      value == null ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value),
  }));
  return (
    <Card
      size="small"
      className="chat-sql-result"
      title={`${sourceName ?? "SQL"} · 问数结果`}
      extra={
        <Tag color={clarifying ? "processing" : "success"}>
          {clarifying ? "待补充" : `${rows.length} 行`}
        </Tag>
      }
    >
      {usage ? (
        <p className="chat-sql-result-note">
          <UsageTag usage={usage} />
        </p>
      ) : null}
      {clarifying ? (
        <Alert type="info" showIcon title={clarifying} />
      ) : (
        <Table
          size="small"
          columns={columns}
          dataSource={rows.map((values, index) => ({ key: String(index), values }))}
          rowKey="key"
          pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }}
          scroll={{ x: "max-content" }}
          locale={{ emptyText: "查询完成，无匹配数据" }}
        />
      )}
      {truncated ? (
        <p className="chat-sql-result-note">结果已达展示上限，可缩小查询范围后继续问数。</p>
      ) : null}
      {sql ? (
        <details className="chat-sql-result-details">
          <summary>查看 SQL</summary>
          <pre className="tool-call-pre">{sql}</pre>
        </details>
      ) : null}
      {steps?.length ? (
        <details className="chat-sql-result-details">
          <summary>
            查询过程{durationMs === undefined ? "" : ` · ${formatDuration(durationMs)}`}
          </summary>
          <QueryExecution steps={steps} auditId={auditId} />
        </details>
      ) : auditId ? (
        <p className="chat-sql-result-note">查询 ID · {auditId}</p>
      ) : null}
    </Card>
  );
}
