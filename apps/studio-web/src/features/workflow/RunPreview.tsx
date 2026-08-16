import { useState } from "react";
import {
  CheckCircleFilled,
  CloseCircleFilled,
  CopyOutlined,
  FlagOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
} from "../../lib/icons.js";
import { nodeOutputs } from "./model.js";
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
}: {
  nodes: WorkflowNode[];
  edges: Edge[];
  running: boolean;
  runDisabled: boolean;
  log: RunLogEntry[];
  outputs: Record<string, Record<string, unknown>> | null;
  onRun: () => void;
  onStop: () => void;
}) {
  const endNodes = nodes.filter((node) => node.data.kind === "end");
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
    <div className="inspector-content run-preview">
      <div className="run-summary">
        <span>
          <b>{nodes.length}</b> 节点
        </span>
        <span>
          <b>{edges.length}</b> 连接
        </span>
      </div>
      <p className="muted-copy">运行会在服务端按拓扑顺序执行节点，并实时回传节点状态。</p>
      <button
        className={`studio-button run full-width${running ? " is-stop" : ""}`}
        type="button"
        disabled={runDisabled}
        onClick={running ? onStop : onRun}
      >
        {running ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
        {running ? "停止运行" : "开始运行"}
      </button>
      <div className="inspector-section-title run-log-title">
        <span>执行记录</span>
        {log.length > 0 && hasDetail ? (
          <span className="run-log-actions">
            <button type="button" onClick={expandAll}>
              全部展开
            </button>
            <button type="button" onClick={collapseAll}>
              全部收起
            </button>
          </span>
        ) : null}
      </div>
      {log.length === 0 ? (
        <div className="run-empty">尚未运行</div>
      ) : (
        <ol className="run-log">
          {log.map((item, index) => (
            <RunLogItem
              key={item.id}
              item={item}
              index={index}
              collapsed={collapsedIds.has(item.id)}
              onToggle={() => toggleLogEntry(item.id)}
            />
          ))}
        </ol>
      )}
      {outputs !== null ? (
        <>
          <div className="inspector-section-title final-output-title">
            <span>最终输出</span>
            <span className="final-output-status">已完成</span>
          </div>
          {endNodes.length === 0 ? (
            <div className="run-empty">未配置结束节点</div>
          ) : (
            <div className="run-output-list">
              {endNodes.map((node) => {
                const bindings = nodeOutputs(node.data);
                const nodeValues = outputs[node.id];
                return (
                  <section className="run-output-block" key={node.id}>
                    <div className="run-output-heading">
                      <FlagOutlined />
                      <b>{node.data.label}</b>
                      <code>{node.id}</code>
                    </div>
                    {bindings.length === 0 ? (
                      <p className="run-output-empty">结束节点未配置输出变量</p>
                    ) : (
                      <div className="run-output-values">
                        {bindings.map((binding) => {
                          const hasValue = Boolean(
                            nodeValues &&
                            Object.prototype.hasOwnProperty.call(nodeValues, binding.name),
                          );
                          return (
                            <div className="run-output-value" key={binding.name}>
                              <div className="run-output-label">
                                <span>{binding.name}</span>
                                <code>{binding.selector}</code>
                              </div>
                              <pre>
                                {hasValue
                                  ? formatWorkflowRunOutput(nodeValues?.[binding.name])
                                  : "未执行"}
                              </pre>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

function RunLogItem({
  item,
  index,
  collapsed,
  onToggle,
}: {
  item: RunLogEntry;
  index: number;
  collapsed: boolean;
  onToggle: () => void;
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
    <li
      className={[
        item.status === "error" ? "is-error" : undefined,
        hasBody ? "has-body" : undefined,
        collapsed ? "is-collapsed" : undefined,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <button type="button" className="run-log-toggle" onClick={onToggle}>
        <span className="run-log-index">{String(index + 1).padStart(2, "0")}</span>
        <b>
          {item.label}
          {item.kind ? <small className="run-log-kind">{item.kind}</small> : null}
          {item.detail ? <small className="run-log-error">{item.detail}</small> : null}
        </b>
        {item.durationMs !== undefined ? (
          <em className="run-log-duration">{formatNodeTestDuration(item.durationMs)}</em>
        ) : null}
        {item.status === "error" ? <CloseCircleFilled /> : <CheckCircleFilled />}
      </button>
      {!collapsed && hasBody ? (
        <div className="run-log-detail">
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
            <div className="run-log-usage">
              <span>输入 {item.tokenUsage?.inputTokens}</span>
              <span>输出 {item.tokenUsage?.outputTokens}</span>
              <span>合计 {item.tokenUsage?.totalTokens}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function RunLogDataBlock({ title, value }: { title: string; value: unknown }) {
  const formatted = formatWorkflowRunOutput(value);
  return (
    <section className="node-test-data-block run-log-data-block">
      <header>
        <b>{title}</b>
        <button
          type="button"
          title={`复制${title}`}
          aria-label={`复制${title}`}
          onClick={() => void navigator.clipboard?.writeText(formatted)}
        >
          <CopyOutlined />
        </button>
      </header>
      <pre>{formatted}</pre>
    </section>
  );
}
