import { useEffect, useState } from "react";
import { Collapse, Flex, Steps, Typography } from "antd";
import { CheckOutlined, CloseOutlined, LoadingOutlined } from "../../lib/icons.js";
import type { QueryAuditStatus, QueryStep } from "./api.js";

export const AUDIT_STATUS_LABELS: Record<QueryAuditStatus, string> = {
  running: "执行中",
  succeeded: "成功",
  failed: "失败",
  clarifying: "待补充",
};

export function auditStatusTag(status: QueryAuditStatus): "processing" | "success" | "error" | "warning" {
  if (status === "running") return "processing";
  if (status === "succeeded") return "success";
  if (status === "failed") return "error";
  return "warning";
}

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

function stepStatus(step: QueryStep["status"]): "wait" | "process" | "finish" | "error" {
  if (step === "running") return "process";
  if (step === "succeeded") return "finish";
  if (step === "failed") return "error";
  return "wait";
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
    <Flex vertical gap={8}>
      {auditId ? (
        <Typography.Paragraph type="secondary" copyable={{ text: auditId }} style={{ fontSize: 12, marginBottom: 0 }} title={auditId}>
          查询 ID · {auditId}
        </Typography.Paragraph>
      ) : null}
      <Steps
        orientation="vertical"
        size="small"
        current={steps.findIndex((step) => step.status === "running")}
        items={steps.map((step) => {
          const duration =
            step.status === "running" && step.startedAt
              ? Math.max(0, now - Date.parse(step.startedAt))
              : step.durationMs;
          return {
            key: step.id,
            status: stepStatus(step.status),
            icon:
              step.status === "running" ? (
                <LoadingOutlined spin />
              ) : step.status === "succeeded" ? (
                <CheckOutlined />
              ) : step.status === "failed" ? (
                <CloseOutlined />
              ) : undefined,
            title: (
              <Flex gap={8} align="center" wrap>
                <Typography.Text strong style={{ fontSize: 13 }}>{step.label}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {STEP_STATUS_LABELS[step.status]}
                </Typography.Text>
                {duration !== undefined ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {formatDuration(duration)}
                  </Typography.Text>
                ) : null}
              </Flex>
            ),
            content: (
              <Flex vertical gap={4}>
                {step.message ? (
                  <Typography.Paragraph type={step.status === "failed" ? "danger" : "secondary"} style={{ fontSize: 12, marginBottom: 0 }}>
                    {step.message}
                  </Typography.Paragraph>
                ) : null}
                {details && (step.input || step.output) ? (
                  <Collapse
                    size="small"
                    items={[
                      {
                        key: "payload",
                        label: "查看输入 / 输出",
                        children: (
                          <Flex vertical gap={4}>
                            {step.startedAt ? (
                              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                开始：{new Date(step.startedAt).toLocaleString()}
                              </Typography.Text>
                            ) : null}
                            {step.finishedAt ? (
                              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                结束：{new Date(step.finishedAt).toLocaleString()}
                              </Typography.Text>
                            ) : null}
                            {step.input ? (
                              <>
                                <Typography.Text strong style={{ fontSize: 12 }}>输入</Typography.Text>
                                <Typography.Paragraph code style={{ fontSize: 12 }}>
                                  {JSON.stringify(step.input, null, 2)}
                                </Typography.Paragraph>
                              </>
                            ) : null}
                            {step.output ? (
                              <>
                                <Typography.Text strong style={{ fontSize: 12 }}>输出</Typography.Text>
                                <Typography.Paragraph code style={{ fontSize: 12 }}>
                                  {JSON.stringify(step.output, null, 2)}
                                </Typography.Paragraph>
                              </>
                            ) : null}
                          </Flex>
                        ),
                      },
                    ]}
                  />
                ) : null}
              </Flex>
            ),
          };
        })}
      />
    </Flex>
  );
}
