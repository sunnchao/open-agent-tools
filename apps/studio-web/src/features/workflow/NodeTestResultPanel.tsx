import { Alert, Button, Descriptions, Flex, Spin, Typography } from "antd";
import { CopyOutlined, PlayCircleOutlined } from "../../lib/icons.js";
import { formatWorkflowRunOutput } from "./runOutput.js";
import type { WorkflowNodeTestResult } from "../../lib/api.js";
import { formatNodeTestDuration, formatNodeTestTime } from "./format.js";
import { QueryExecution } from "../observatory/QueryExecution.js";
import type { QueryStep } from "../observatory/api.js";

export function NodeTestResultPanel({
  result,
  pending,
  disabled,
  onTest,
}: {
  result?: WorkflowNodeTestResult;
  pending: boolean;
  disabled: boolean;
  onTest: () => void;
}) {
  if (!result) {
    return (
      <Flex vertical className="node-test-empty">
        {pending ? <Spin size="small" /> : <PlayCircleOutlined />}
        <Typography.Text strong>{pending ? "节点测试运行中" : "暂无测试记录"}</Typography.Text>
        <Typography.Paragraph>
          {pending
            ? "正在等待服务端返回执行结果。"
            : "单独运行当前节点后，可查看输入、输出和元数据。"}
        </Typography.Paragraph>
        {!pending ? (
          <Button
            className="studio-button run"
            type="text"
            htmlType="button"
            onClick={onTest}
            disabled={disabled}
          >
            <PlayCircleOutlined /> 测试运行
          </Button>
        ) : null}
      </Flex>
    );
  }

  const usage = result.metadata.tokenUsage;
  const queryResult =
    result.metadata.nodeKind === "sql" && result.result
      ? (result.result as { steps?: QueryStep[]; auditId?: string })
      : null;
  return (
    <Flex vertical className="node-test-result">
      <Flex vertical className={`node-test-summary is-${result.status}`}>
        <Typography.Text>
          <Typography.Text type="secondary">状态</Typography.Text>
          <Typography.Text strong>
            {result.status === "success" ? "SUCCESS" : "ERROR"}
          </Typography.Text>
        </Typography.Text>
        <Typography.Text>
          <Typography.Text type="secondary">运行时间</Typography.Text>
          <Typography.Text strong>
            {formatNodeTestDuration(result.metadata.durationMs)}
          </Typography.Text>
        </Typography.Text>
        <Typography.Text>
          <Typography.Text type="secondary">总 TOKEN 数</Typography.Text>
          <Typography.Text strong>{usage.totalTokens} Tokens</Typography.Text>
        </Typography.Text>
      </Flex>
      {result.error ? (
        <Alert className="node-test-error" type="error" title={result.error} showIcon />
      ) : null}
      {Array.isArray(queryResult?.steps) ? (
        <QueryExecution steps={queryResult.steps} auditId={queryResult.auditId} details />
      ) : null}
      <NodeTestDataBlock title="输入" value={result.inputs} />
      <NodeTestDataBlock title="数据处理" value={result.result} />
      <NodeTestDataBlock title="输出" value={result.outputs} />
      <Flex vertical className="node-test-metadata">
        <Flex vertical className="inspector-section-title">
          元数据
        </Flex>
        <Descriptions
          size="small"
          column={1}
          items={[
            { key: "status", label: "状态", children: result.status.toUpperCase() },
            { key: "kind", label: "节点类型", children: result.metadata.nodeKind },
            { key: "id", label: "节点 ID", children: result.nodeId },
            {
              key: "start",
              label: "开始时间",
              children: formatNodeTestTime(result.metadata.startedAt),
            },
            {
              key: "finish",
              label: "结束时间",
              children: formatNodeTestTime(result.metadata.finishedAt),
            },
            {
              key: "duration",
              label: "运行时间",
              children: formatNodeTestDuration(result.metadata.durationMs),
            },
            { key: "input", label: "输入 Tokens", children: usage.inputTokens },
            { key: "output", label: "输出 Tokens", children: usage.outputTokens },
            { key: "total", label: "总 Token 数", children: usage.totalTokens },
          ]}
        />
      </Flex>
      <Button
        className="studio-button secondary full-width node-test-rerun"
        type="text"
        htmlType="button"
        onClick={onTest}
        disabled={pending || disabled}
      >
        <PlayCircleOutlined /> {pending ? "测试中..." : "重新测试"}
      </Button>
    </Flex>
  );
}

export function NodeTestDataBlock({ title, value }: { title: string; value: unknown }) {
  const formatted = formatWorkflowRunOutput(value);
  return (
    <Flex vertical className="node-test-data-block">
      <Flex className="node-test-data-heading">
        <Typography.Text strong>{title}</Typography.Text>
        <Button
          type="text"
          htmlType="button"
          title={`复制${title}`}
          aria-label={`复制${title}`}
          onClick={() => void navigator.clipboard?.writeText(formatted)}
        >
          <CopyOutlined />
        </Button>
      </Flex>
      <Typography.Paragraph className="workflow-code-block">{formatted}</Typography.Paragraph>
    </Flex>
  );
}
