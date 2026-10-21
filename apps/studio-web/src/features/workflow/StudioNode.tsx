import { Handle, Position, useUpdateNodeInternals, type NodeProps } from "@xyflow/react";
import { createContext, useContext, useEffect } from "react";
import { CheckCircleFilled, CloseCircleFilled } from "../../lib/icons.js";
import { nodeInputs, nodeOutputs } from "./model.js";
import type { NodeRunStatus, WorkflowNodeData } from "./model.js";
import { iconByKind } from "./palette.js";
import type { WorkflowNode } from "./types.js";
import { conditionBranches, branchHandle } from "./condition.js";

export const WorkflowBranchActionsContext = createContext<
  ((nodeId: string, branchId: string, anchor: { x: number; y: number }) => void) | null
>(null);

export function StudioNode({ data, selected }: NodeProps<WorkflowNode>) {
  const addBranchNode = useContext(WorkflowBranchActionsContext);
  const updateInternals = useUpdateNodeInternals();
  const branches = data.kind === "condition" ? conditionBranches(data.config) : [];
  const signature = branches.map((branch) => branch.id).join(",");
  useEffect(() => {
    if (data.kind === "condition") updateInternals(data.id);
  }, [data.id, data.kind, signature, updateInternals]);
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
      {data.kind === "condition" ? (
        <div className="condition-node-branches">
          {branches.map((branch) => (
            <div className="condition-node-branch" key={branch.id}>
              <span>{branch.caseLabel}</span>
              <b>{branch.label}</b>
              <Handle
                type="source"
                position={Position.Right}
                id={branchHandle(branch.id)}
                className="condition-port-add"
                role="button"
                tabIndex={0}
                aria-label={`${data.label} ${branch.caseLabel} 添加下一节点`}
                onClick={(event) => {
                  event.stopPropagation();
                  addBranchNode?.(data.id, branch.id, { x: event.clientX, y: event.clientY });
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  const rect = event.currentTarget.getBoundingClientRect();
                  addBranchNode?.(data.id, branch.id, { x: rect.right, y: rect.top });
                }}
              >
                <span>+</span>
              </Handle>
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="node-summary">{nodeSummary(data)}</div>
          <div className="node-summary">NODE ID: {data.id}</div>
          {data.kind !== "end" ? <Handle type="source" position={Position.Right} /> : null}
        </>
      )}
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
    const sources = Array.isArray(data.config.sources) ? data.config.sources : [];
    return sources.length > 0 ? `${sources.length} 个文档 · 图谱检索` : "选择图谱文档";
  }
  if (data.kind === "sql") return String(data.config.query || "配置问数问题");
  if (data.kind === "llm") return `MODEL: ${String(data.config.model)}`;
  if (data.kind === "mcp")
    return data.config.toolName
      ? `${data.config.serviceSlug} / ${data.config.toolName}`
      : "选择 MCP Tool";
  if (data.kind === "http")
    return `${String(data.config.method ?? "get").toUpperCase()} · ${String(data.config.url ?? "").split("?")[0] || "配置目标 URL"}`;
  if (data.kind === "condition") return String(data.config.expression);
  if (data.kind === "input")
    return `输入 ${nodeInputs(data).length} · 输出 ${nodeOutputs(data).length}`;
  if (data.kind === "end") return `输出 ${nodeOutputs(data).length}`;
  return "点击运行开始执行";
}
