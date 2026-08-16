import { CopyOutlined, PlayCircleOutlined } from "../../lib/icons.js";
import { formatWorkflowRunOutput } from "./runOutput.js";
import type { WorkflowNodeTestResult } from "../../lib/api.js";
import { formatNodeTestDuration, formatNodeTestTime } from "./format.js";

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
      <div className="node-test-empty">
        {pending ? <span className="node-running" /> : <PlayCircleOutlined />}
        <b>{pending ? "节点测试运行中" : "暂无测试记录"}</b>
        <p>
          {pending
            ? "正在等待服务端返回执行结果。"
            : "单独运行当前节点后，可查看输入、输出和元数据。"}
        </p>
        {!pending ? (
          <button className="studio-button run" type="button" onClick={onTest} disabled={disabled}>
            <PlayCircleOutlined /> 测试运行
          </button>
        ) : null}
      </div>
    );
  }

  const usage = result.metadata.tokenUsage;
  return (
    <div className="node-test-result">
      <div className={`node-test-summary is-${result.status}`}>
        <span>
          <small>状态</small>
          <b>{result.status === "success" ? "SUCCESS" : "ERROR"}</b>
        </span>
        <span>
          <small>运行时间</small>
          <b>{formatNodeTestDuration(result.metadata.durationMs)}</b>
        </span>
        <span>
          <small>总 TOKEN 数</small>
          <b>{usage.totalTokens} Tokens</b>
        </span>
      </div>
      {result.error ? <div className="node-test-error">{result.error}</div> : null}
      <NodeTestDataBlock title="输入" value={result.inputs} />
      <NodeTestDataBlock title="数据处理" value={result.result} />
      <NodeTestDataBlock title="输出" value={result.outputs} />
      <div className="node-test-metadata">
        <div className="inspector-section-title">元数据</div>
        <dl>
          <div>
            <dt>状态</dt>
            <dd>{result.status.toUpperCase()}</dd>
          </div>
          <div>
            <dt>节点类型</dt>
            <dd>{result.metadata.nodeKind}</dd>
          </div>
          <div>
            <dt>节点 ID</dt>
            <dd>{result.nodeId}</dd>
          </div>
          <div>
            <dt>开始时间</dt>
            <dd>{formatNodeTestTime(result.metadata.startedAt)}</dd>
          </div>
          <div>
            <dt>结束时间</dt>
            <dd>{formatNodeTestTime(result.metadata.finishedAt)}</dd>
          </div>
          <div>
            <dt>运行时间</dt>
            <dd>{formatNodeTestDuration(result.metadata.durationMs)}</dd>
          </div>
          <div>
            <dt>输入 Tokens</dt>
            <dd>{usage.inputTokens}</dd>
          </div>
          <div>
            <dt>输出 Tokens</dt>
            <dd>{usage.outputTokens}</dd>
          </div>
          <div>
            <dt>总 Token 数</dt>
            <dd>{usage.totalTokens}</dd>
          </div>
        </dl>
      </div>
      <button
        className="studio-button secondary full-width node-test-rerun"
        type="button"
        onClick={onTest}
        disabled={pending || disabled}
      >
        <PlayCircleOutlined /> {pending ? "测试中..." : "重新测试"}
      </button>
    </div>
  );
}

export function NodeTestDataBlock({ title, value }: { title: string; value: unknown }) {
  const formatted = formatWorkflowRunOutput(value);
  return (
    <section className="node-test-data-block">
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
