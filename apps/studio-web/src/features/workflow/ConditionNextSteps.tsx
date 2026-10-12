import { Button } from "antd";
import type { Edge } from "@xyflow/react";
import { CloseOutlined, PlusOutlined } from "../../lib/icons.js";
import { conditionBranches, edgeBranch } from "./condition.js";
import { iconByKind } from "./palette.js";
import type { WorkflowNode } from "./types.js";

export function ConditionNextSteps({
  node,
  nodes,
  edges,
  onAdd,
  onRemove,
  onFocus,
}: {
  node: WorkflowNode;
  nodes: WorkflowNode[];
  edges: Edge[];
  onAdd: (branchId: string, anchor: { x: number; y: number }) => void;
  onRemove: (edgeId: string) => void;
  onFocus: (nodeId: string) => void;
}) {
  const branches = conditionBranches(node.data.config);
  return (
    <section className="condition-next-steps">
      <h4>下一步</h4>
      <p>为各分支选择接下来执行的节点</p>
      <div className="condition-next-tree">
        <span className="condition-next-origin" aria-hidden="true">
          {iconByKind.condition}
        </span>
        {branches.map((branch) => {
          const targets = edges.filter(
            (edge) => edge.source === node.id && edgeBranch(node.data.config, edge) === branch.id,
          );
          return (
            <div className="condition-next-card" key={branch.id}>
              <span className="condition-next-label">{branch.caseLabel}</span>
              {targets.map((edge) => (
                <div className="condition-next-target" key={edge.id}>
                  <Button type="text" htmlType="button" onClick={() => onFocus(edge.target)}>
                    {nodes.find((item) => item.id === edge.target)?.data.label ?? "已失效节点"}
                  </Button>
                  <Button
                    type="text"
                    htmlType="button"
                    aria-label={`移除 ${branch.caseLabel} 到 ${edge.target} 的连接`}
                    onClick={() => onRemove(edge.id)}
                  >
                    <CloseOutlined />
                  </Button>
                </div>
              ))}
              <Button
                className="condition-next-add"
                type="text"
                htmlType="button"
                aria-label={`${branch.caseLabel} 选择下一节点`}
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  onAdd(branch.id, { x: rect.left + rect.width / 2, y: rect.bottom });
                }}
              >
                <PlusOutlined /> {targets.length ? "添加下一节点" : "选择下一节点"}
              </Button>
              {!targets.length && <span className="condition-unconnected">尚未连接</span>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
