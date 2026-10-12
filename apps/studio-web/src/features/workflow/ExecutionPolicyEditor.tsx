import { Collapse, Form, InputNumber, Select, Slider, Typography } from "antd";
import type { WorkflowNodeData } from "./model.js";

export function ExecutionPolicyEditor({
  data,
  updateConfig,
}: {
  data: WorkflowNodeData;
  updateConfig: (key: string, value: unknown) => void;
}) {
  if (!["rag", "graph", "llm", "mcp", "http"].includes(data.kind)) return null;
  const timeout = Number(
    data.config.timeoutMs ?? (["rag", "graph"].includes(data.kind) ? 15000 : 30000),
  );
  const retry = data.config.retry as { maxRetries: number; delayMs?: number } | undefined;
  return (
    <Collapse
      className="workflow-execution-policy"
      ghost
      items={[
        {
          key: "policy",
          label: "高级执行设置",
          children: (
            <>
              <Form.Item label="超时（秒）">
                <Slider
                  min={1}
                  max={120}
                  value={timeout / 1000}
                  ariaLabelForHandle="超时滑块"
                  onChange={(value) => updateConfig("timeoutMs", value * 1000)}
                />
                <InputNumber
                  aria-label="超时（秒）"
                  min={1}
                  max={120}
                  step={1}
                  value={timeout / 1000}
                  onChange={(value) => {
                    if (value !== null)
                      updateConfig("timeoutMs", Math.min(120, Math.max(1, value)) * 1000);
                  }}
                />
              </Form.Item>
              {data.kind === "llm" ? (
                <Typography.Paragraph className="field-help">
                  LLM 失败时不自动重试，避免重复计费。
                </Typography.Paragraph>
              ) : (
                <>
                  <Form.Item label="最多重试">
                    <Select
                      aria-label="最多重试"
                      value={retry?.maxRetries ?? 0}
                      onChange={(value) => updateConfig("retry", { ...retry, maxRetries: value })}
                      options={[0, 1, 2, 3].map((value) => ({
                        value,
                        label: value === 0 ? "不重试" : `${value} 次`,
                      }))}
                    />
                  </Form.Item>
                  <Form.Item label="首次重试间隔（秒）">
                    <InputNumber
                      aria-label="首次重试间隔（秒）"
                      min={0.1}
                      max={10}
                      step={0.1}
                      value={(retry?.delayMs ?? 500) / 1000}
                      onChange={(value) => {
                        if (value !== null)
                          updateConfig("retry", {
                            maxRetries: retry?.maxRetries ?? 0,
                            delayMs: Math.round(Math.min(10, Math.max(0.1, value)) * 1000),
                          });
                      }}
                    />
                  </Form.Item>
                  <Typography.Paragraph className="field-help">
                    仅重试暂时性网络或服务错误，间隔指数递增。工具可能有副作用，请按需开启。
                  </Typography.Paragraph>
                </>
              )}
            </>
          ),
        },
      ]}
    />
  );
}
