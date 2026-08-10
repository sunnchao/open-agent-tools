import { Collapse, Flex, Tag, Typography } from "antd";
import { SettingOutlined } from "../lib/icons.js";
import type { ToolCall } from "../types.js";

interface ToolCallsProps {
  toolCalls?: ToolCall[];
}

function pretty(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const STATUS_LABEL: Record<string, string> = {
  pending: "执行中",
  done: "已完成",
  error: "失败",
};

const STATUS_COLOR: Record<string, string> = {
  pending: "processing",
  done: "success",
  error: "error",
};

/**
 * 在助手消息内渲染“函数调用（function calling）”记录：
 * 工具名 + 生命周期状态，可展开查看参数与结果（或卡片）。
 */
export function ToolCalls({ toolCalls }: ToolCallsProps) {
  if (!toolCalls || toolCalls.length === 0) return null;

  const items = toolCalls.map((call, index) => {
    const status =
      call.status ?? (call.error ? "error" : call.result || call.ui ? "done" : "pending");
    const key = call.id ?? `tc-${index}`;

    return {
      key,
      label: (
        <Flex align="center" gap={8} wrap="wrap">
          <SettingOutlined />
          <Typography.Text strong>{call.name}</Typography.Text>
          <Tag color={STATUS_COLOR[status] ?? "default"}>{STATUS_LABEL[status] ?? status}</Tag>
        </Flex>
      ),
      children: (
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            参数 arguments
          </Typography.Text>
          <pre className="tool-call-pre">{pretty(call.arguments)}</pre>
          {(call.result !== undefined || call.ui !== undefined || call.error !== undefined) && (
            <div style={{ marginTop: 10 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {call.error ? "错误 error" : "结果 result"}
              </Typography.Text>
              {call.ui ? (
                <pre className="tool-call-pre">（结果已作为卡片展示在上方 ↕）</pre>
              ) : call.error ? (
                <pre className="tool-call-pre tool-call-pre--error">{call.error}</pre>
              ) : (
                <pre className="tool-call-pre">{pretty(call.result)}</pre>
              )}
            </div>
          )}
        </div>
      ),
    };
  });

  return (
    <Collapse
      size="small"
      style={{ marginTop: 10 }}
      items={items}
    />
  );
}
