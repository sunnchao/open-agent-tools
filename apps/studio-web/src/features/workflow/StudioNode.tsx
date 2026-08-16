import { Handle, Position, type NodeProps } from "@xyflow/react";
import { CheckCircleFilled, CloseCircleFilled } from "../../lib/icons.js";
import { nodeInputs, nodeOutputs } from "./model.js";
import type { NodeRunStatus, WorkflowNodeData } from "./model.js";
import { iconByKind } from "./palette.js";
import type { WorkflowNode } from "./types.js";

export function StudioNode({ data, selected }: NodeProps<WorkflowNode>) {
  return (
    <div
      className={`workflow-node kind-${data.kind} status-${data.status}${selected ? " is-selected" : ""}`}
    >
      {data.kind !== "start" ? <Handle type="target" position={Position.Left} /> : null}
      <header>
        <span className="node-icon">{iconByKind[data.kind]}</span>
        <span className="node-copy">
          <b>{data.label}</b>
          <small>{data.description}</small>
        </span>
        <NodeStatus status={data.status} />
      </header>
      <div className="node-summary">{nodeSummary(data)}</div>
      <div className="node-summary">NODE ID: {data.id}</div>
      {data.kind !== "end" ? <Handle type="source" position={Position.Right} /> : null}
    </div>
  );
}

function NodeStatus({ status }: { status: NodeRunStatus }) {
  if (status === "running") return <span className="node-running" />;
  if (status === "success") return <CheckCircleFilled className="node-success" />;
  if (status === "error") return <CloseCircleFilled className="node-error" />;
  return <span className="node-idle" aria-hidden="true" />;
}

function nodeSummary(data: WorkflowNodeData): string {
  if (data.kind === "rag") {
    const sources = Array.isArray(data.config.sources) ? data.config.sources : [];
    return sources.length > 0
      ? `${sources.length} 个文档 · Top-${data.config.topK}`
      : "选择 RAG 文档";
  }
  if (data.kind === "graph") {
    return String(data.config.query ?? "{{query}}");
  }
  if (data.kind === "llm") return `MODEL: ${String(data.config.model)}`;
  if (data.kind === "mcp")
    return data.config.toolName
      ? `${data.config.serviceSlug} / ${data.config.toolName}`
      : "选择 MCP Tool";
  if (data.kind === "condition") return String(data.config.expression);
  if (data.kind === "input")
    return `输入 ${nodeInputs(data).length} · 输出 ${nodeOutputs(data).length}`;
  if (data.kind === "end") return `输出 ${nodeOutputs(data).length}`;
  return "点击运行开始执行";
}
