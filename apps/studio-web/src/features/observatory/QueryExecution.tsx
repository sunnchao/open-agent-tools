import { useEffect, useState } from "react";
import { CheckOutlined, CloseOutlined, LoadingOutlined } from "../../lib/icons.js";
import type { QueryAuditStatus, QueryStep } from "./api.js";
import "./observatory.css";

export const AUDIT_STATUS_LABELS: Record<QueryAuditStatus, string> = {
  running: "执行中",
  succeeded: "成功",
  failed: "失败",
  clarifying: "待补充",
};

const STEP_STATUS_LABELS: Record<QueryStep["status"], string> = {
  pending: "待执行",
  running: "执行中",
  succeeded: "已完成",
  failed: "失败",
  skipped: "已跳过",
};

export function formatDuration(durationMs: number): string {
  return durationMs < 1000 ? `${durationMs} ms` : `${(durationMs / 1000).toFixed(1)} s`;
}

export function QueryExecution({
  steps,
  auditId,
  details = false,
}: {
  steps: QueryStep[];
  auditId?: string;
  details?: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  const running = steps.some((step) => step.status === "running");
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [running]);

  return (
    <div className="obs-execution">
      {auditId ? (
        <p className="obs-request-id" title={auditId}>
          查询 ID · {auditId}
        </p>
      ) : null}
      <ol className="obs-steps" aria-label="查询执行步骤" aria-live="polite">
        {steps.map((step, index) => {
          const duration =
            step.status === "running" && step.startedAt
              ? Math.max(0, now - Date.parse(step.startedAt))
              : step.durationMs;
          return (
            <li key={step.id} className={`obs-step is-${step.status}`}>
              <span className="obs-step-mark" aria-hidden="true">
                {step.status === "running" ? (
                  <LoadingOutlined spin />
                ) : step.status === "succeeded" ? (
                  <CheckOutlined />
                ) : step.status === "failed" ? (
                  <CloseOutlined />
                ) : (
                  index + 1
                )}
              </span>
              <div className="obs-step-content">
                <div className="obs-step-heading">
                  <strong>{step.label}</strong>
                  <span>{STEP_STATUS_LABELS[step.status]}</span>
                  {duration !== undefined ? <time>{formatDuration(duration)}</time> : null}
                </div>
                {step.message ? <p>{step.message}</p> : null}
                {details && (step.input || step.output) ? (
                  <details className="obs-step-payload">
                    <summary>查看输入 / 输出</summary>
                    {step.startedAt ? (
                      <p>开始：{new Date(step.startedAt).toLocaleString()}</p>
                    ) : null}
                    {step.finishedAt ? (
                      <p>结束：{new Date(step.finishedAt).toLocaleString()}</p>
                    ) : null}
                    {step.input ? (
                      <>
                        <b>输入</b>
                        <pre>{JSON.stringify(step.input, null, 2)}</pre>
                      </>
                    ) : null}
                    {step.output ? (
                      <>
                        <b>输出</b>
                        <pre>{JSON.stringify(step.output, null, 2)}</pre>
                      </>
                    ) : null}
                  </details>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
