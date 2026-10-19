import { Alert, Descriptions, Empty, Segmented, Spin, Typography } from "antd";
import { useEffect, useState } from "react";
import { getAuditEvent, type AuditEventRecord } from "./api.js";

const payloads = [
  { value: "input", label: "请求输入" },
  { value: "output", label: "响应输出" },
  { value: "context", label: "执行上下文" },
] as const;

export function AuditEventDetails({ eventId }: { eventId: string }) {
  const [event, setEvent] = useState<AuditEventRecord | null>(null);
  const [error, setError] = useState("");
  const [payload, setPayload] = useState<"input" | "output" | "context">("input");

  useEffect(() => {
    let cancelled = false;
    getAuditEvent(eventId)
      .then((value) => {
        if (!cancelled) setEvent(value);
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  if (error)
    return <Alert type="error" showIcon message={error} role="alert" />;
  if (!event)
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: 24 }}>
        <Spin tip="正在读取完整审计内容..." />
      </div>
    );
  const value = event[payload];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Descriptions size="small" column={1} bordered>
        <Descriptions.Item label="动作">{event.action}</Descriptions.Item>
        <Descriptions.Item label="来源">
          {event.source === "gateway" ? "MCP Gateway" : "管理控制面"}
        </Descriptions.Item>
        <Descriptions.Item label="Request ID">{event.requestId}</Descriptions.Item>
        <Descriptions.Item label="结果 / 耗时">
          {event.outcome} · HTTP {event.statusCode} · {event.durationMs} ms
        </Descriptions.Item>
      </Descriptions>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
        API
        Key、环境变量值和签名凭证已脱敏。完整业务内容可能包含敏感数据，请仅向维护人员开放审计访问。
      </Typography.Paragraph>
      <Segmented
        aria-label="审计内容类型"
        value={payload}
        onChange={(value) => setPayload(value as typeof payload)}
        options={payloads.map((item) => ({ ...item }))}
      />
      {value === null || value === undefined ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="无记录。历史事件未采集输入输出，新事件开始保存完整内容。"
        />
      ) : (
        <Typography.Paragraph
          code
          copyable
          tabIndex={0}
          aria-label={payloads.find((item) => item.value === payload)!.label}
          style={{ whiteSpace: "pre-wrap", marginBottom: 0 }}
        >
          {JSON.stringify(value, null, 2)}
        </Typography.Paragraph>
      )}
    </div>
  );
}
