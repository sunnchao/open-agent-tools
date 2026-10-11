import { useEffect, useState } from "react";
import { getAuditEvent, type AuditEventRecord } from "./api.js";

const payloads = [
  { key: "input", label: "请求输入" },
  { key: "output", label: "响应输出" },
  { key: "context", label: "执行上下文" },
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
    return (
      <p className="field-message error" role="alert">
        {error}
      </p>
    );
  if (!event)
    return (
      <p className="muted-copy" role="status">
        正在读取完整审计内容...
      </p>
    );
  const value = event[payload];

  return (
    <div className="audit-event-details">
      <dl className="audit-event-metadata">
        <div>
          <dt>动作</dt>
          <dd>{event.action}</dd>
        </div>
        <div>
          <dt>来源</dt>
          <dd>{event.source === "gateway" ? "MCP Gateway" : "管理控制面"}</dd>
        </div>
        <div>
          <dt>Request ID</dt>
          <dd>{event.requestId}</dd>
        </div>
        <div>
          <dt>结果 / 耗时</dt>
          <dd>
            {event.outcome} · HTTP {event.statusCode} · {event.durationMs} ms
          </dd>
        </div>
      </dl>
      <p className="muted-copy">
        API
        Key、环境变量值和签名凭证已脱敏。完整业务内容可能包含敏感数据，请仅向维护人员开放审计访问。
      </p>
      <div className="segmented-control" aria-label="审计内容类型">
        {payloads.map((item) => (
          <button
            key={item.key}
            type="button"
            className={payload === item.key ? "is-active" : ""}
            onClick={() => setPayload(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {value === null || value === undefined ? (
        <p className="audit-payload-empty">
          无记录。历史事件未采集输入输出，新事件开始保存完整内容。
        </p>
      ) : (
        <pre
          className="audit-payload"
          tabIndex={0}
          aria-label={payloads.find((item) => item.key === payload)!.label}
        >
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  );
}
