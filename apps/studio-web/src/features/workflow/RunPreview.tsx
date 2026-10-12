import { Alert, Button, Empty, Flex, Typography } from "antd";
import { useState } from "react";
import {
  CheckCircleFilled,
  CloseCircleFilled,
  CopyOutlined,
  FlagOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
} from "../../lib/icons.js";
import { formatWorkflowRunOutput } from "./runOutput.js";
import { formatNodeTestDuration } from "./format.js";
import type { RunLogEntry, WorkflowNode } from "./types.js";
import type { Edge } from "@xyflow/react";

export function RunPreview({
  nodes,
  edges,
  running,
  runDisabled,
  log,
  outputs,
  onRun,
  onStop,
  readOnly = false,
  onResume,
  resumeIssue,
}: {
  nodes: WorkflowNode[];
  edges: Edge[];
  running: boolean;
  runDisabled: boolean;
  log: RunLogEntry[];
  outputs: Record<string, unknown> | null;
  onRun: () => void;
  onStop: () => void;
  readOnly?: boolean;
  onResume?: (nodeId: string) => void;
  resumeIssue?: (nodeId: string) => string | null;
}) {
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const toggleLogEntry = (id: string) =>
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const collapseAll = () => setCollapsedIds(new Set(log.map((item) => item.id)));
  const expandAll = () => setCollapsedIds(new Set());
  const hasDetail = log.some(
    (item) =>
      item.inputs !== undefined ||
      item.outputs !== undefined ||
      item.result !== undefined ||
      item.prompt !== undefined ||
      item.systemPrompt !== undefined ||
      item.detail !== undefined ||
      item.tokenUsage !== undefined,
  );
  return (
    <Flex vertical className="inspector-content run-preview">
      <Flex className="run-summary">
        <Typography.Text>
          <Typography.Text strong>{nodes.length}</Typography.Text> 节点
        </Typography.Text>
        <Typography.Text>
          <Typography.Text strong>{edges.length}</Typography.Text> 连接
        </Typography.Text>
      </Flex>
      <Typography.Paragraph className="muted-copy">
        {readOnly
          ? "历史轨迹来自当次运行快照，仅供查看。"
          : "运行会在服务端按拓扑顺序执行节点，并实时回传节点状态。"}
      </Typography.Paragraph>
      {!readOnly && (
        <Button
          className={`studio-button run full-width${running ? " is-stop" : ""}`}
          type="text"
          htmlType="button"
          disabled={runDisabled}
          onClick={running ? onStop : onRun}
        >
          {running ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
          {running ? "停止运行" : "开始运行"}
        </Button>
      )}
      <Flex className="inspector-section-title run-log-title">
        <Typography.Text>执行记录</Typography.Text>
        {log.length > 0 && hasDetail ? (
          <Typography.Text className="run-log-actions">
            <Button type="text" htmlType="button" onClick={expandAll}>
              全部展开
            </Button>
            <Button type="text" htmlType="button" onClick={collapseAll}>
              全部收起
            </Button>
          </Typography.Text>
        ) : null}
      </Flex>
      {log.length === 0 ? (
        <Empty className="run-empty" image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未运行" />
      ) : (
        <Flex vertical className="run-log" role="list">
          {log.map((item, index) => (
            <RunLogItem
              key={item.id}
              item={item}
              index={index}
              collapsed={collapsedIds.has(item.id)}
              onToggle={() => toggleLogEntry(item.id)}
              onResume={onResume}
              resumeIssue={resumeIssue?.(item.id) ?? null}
            />
          ))}
        </Flex>
      )}
      {outputs !== null ? (
        <>
          <Flex className="inspector-section-title final-output-title">
            <Typography.Text>最终输出</Typography.Text>
            <Typography.Text className="final-output-status">已完成</Typography.Text>
          </Flex>
          {Object.keys(outputs).length === 0 ? (
            <Empty
              className="run-empty"
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="没有已执行的结果输出"
            />
          ) : (
            <Flex vertical className="run-output-list">
              <Flex vertical className="run-output-block">
                <Flex className="run-output-heading">
                  <FlagOutlined />
                  <Typography.Text strong>合并结果</Typography.Text>
                </Flex>
                <Flex vertical className="run-output-values">
                  {Object.entries(outputs).map(([name, value]) => (
                    <Flex vertical className="run-output-value" key={name}>
                      <Flex className="run-output-label">
                        <Typography.Text>{name}</Typography.Text>
                      </Flex>
                      <Typography.Paragraph className="workflow-code-block">
                        {formatWorkflowRunOutput(value)}
                      </Typography.Paragraph>
                    </Flex>
                  ))}
                </Flex>
              </Flex>
            </Flex>
          )}
        </>
      ) : null}
    </Flex>
  );
}

function RunLogItem({
  item,
  index,
  collapsed,
  onToggle,
  onResume,
  resumeIssue,
}: {
  item: RunLogEntry;
  index: number;
  collapsed: boolean;
  onToggle: () => void;
  onResume?: (nodeId: string) => void;
  resumeIssue: string | null;
}) {
  const hasBody =
    item.detail !== undefined ||
    item.inputs !== undefined ||
    item.outputs !== undefined ||
    item.result !== undefined ||
    item.prompt !== undefined ||
    item.systemPrompt !== undefined ||
    item.tokenUsage !== undefined;
  const hasUsage =
    item.tokenUsage !== undefined &&
    (item.tokenUsage.totalTokens > 0 ||
      item.tokenUsage.inputTokens > 0 ||
      item.tokenUsage.outputTokens > 0);
  return (
    <Flex
      vertical
      role="listitem"
      className={[
        "run-log-item",
        item.status === "error" ? "is-error" : undefined,
        hasBody ? "has-body" : undefined,
        collapsed ? "is-collapsed" : undefined,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <Button type="text" htmlType="button" className="run-log-toggle" onClick={onToggle}>
        <Typography.Text className="run-log-index">
          {String(index + 1).padStart(2, "0")}
        </Typography.Text>
        <Flex vertical className="run-log-copy">
          <Typography.Text strong>{item.label}</Typography.Text>
          {item.kind ? (
            <Typography.Text className="run-log-kind">{item.kind}</Typography.Text>
          ) : null}
          {item.detail ? (
            <Typography.Text className="run-log-error">{item.detail}</Typography.Text>
          ) : null}
        </Flex>
        {item.durationMs !== undefined ? (
          <Typography.Text className="run-log-duration">
            {formatNodeTestDuration(item.durationMs)}
          </Typography.Text>
        ) : null}
        {item.status === "error" ? <CloseCircleFilled /> : <CheckCircleFilled />}
      </Button>
      {item.selectedBranchLabel && (
        <span className="condition-run-selected">命中 {item.selectedBranchLabel}</span>
      )}
      {!collapsed &&
        item.warnings?.map((warning, warningIndex) => (
          <Alert
            key={warningIndex}
            type="warning"
            title={`${warning.caseLabel ?? warning.caseId} 条件 ${warning.ruleIndex + 1}：${warning.message}`}
          />
        ))}
      {onResume && item.status === "success" ? (
        <Button
          className="variable-text-button"
          type="text"
          htmlType="button"
          disabled={Boolean(resumeIssue)}
          title={resumeIssue ?? "复用上游真实输出，执行当前草稿的该节点及下游"}
          onClick={() => onResume(item.id)}
        >
          从此节点续跑
        </Button>
      ) : null}
      {!collapsed && hasBody ? (
        <Flex vertical className="run-log-detail">
          {item.cached ? (
            <Typography.Paragraph className="field-help">
              复用历史缓存 · 本次未执行
            </Typography.Paragraph>
          ) : null}
          {item.attempts && item.attempts > 1 ? (
            <Typography.Paragraph className="field-help">
              第 {item.attempts} 次尝试{item.status === "success" ? "成功" : "失败"}
            </Typography.Paragraph>
          ) : null}
          {item.systemPrompt !== undefined ? (
            <RunLogDataBlock title="系统提示词" value={item.systemPrompt} />
          ) : null}
          {item.prompt !== undefined ? (
            <RunLogDataBlock title="用户消息（最终请求）" value={item.prompt} />
          ) : null}
          {item.inputs !== undefined ? <RunLogDataBlock title="输入" value={item.inputs} /> : null}
          {item.outputs !== undefined ? (
            <RunLogDataBlock title="输出" value={item.outputs} />
          ) : null}
          {item.result !== undefined ? (
            <RunLogDataBlock title="原始结果" value={item.result} />
          ) : null}
          {hasUsage ? (
            <Flex className="run-log-usage">
              <Typography.Text>输入 {item.tokenUsage?.inputTokens}</Typography.Text>
              <Typography.Text>输出 {item.tokenUsage?.outputTokens}</Typography.Text>
              <Typography.Text>合计 {item.tokenUsage?.totalTokens}</Typography.Text>
            </Flex>
          ) : null}
        </Flex>
      ) : null}
    </Flex>
  );
}

function RunLogDataBlock({ title, value }: { title: string; value: unknown }) {
  const formatted = formatWorkflowRunOutput(value);
  return (
    <Flex vertical className="node-test-data-block run-log-data-block">
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
