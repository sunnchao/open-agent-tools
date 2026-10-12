import { App, Button, Collapse } from "antd";
import { conditionCases, isVisualCondition } from "@open-agent-tools/workflow-contracts";
import type { Edge } from "@xyflow/react";
import { DeleteOutlined, PlusOutlined } from "../../lib/icons.js";
import { ConditionBuilder } from "./ConditionBuilder.js";
import { ConditionNextSteps } from "./ConditionNextSteps.js";
import { newConditionCase, branchIdOf } from "./condition.js";
import { TemplateField } from "./TemplateField.js";
import { nodeInputs } from "./model.js";
import type { WorkflowNode } from "./types.js";

export function ConditionBranchEditor({
  node,
  nodes,
  edges,
  onChange,
  onAdd,
  onRemove,
  onFocus,
}: {
  node: WorkflowNode;
  nodes: WorkflowNode[];
  edges: Edge[];
  onChange: (config: Record<string, unknown>) => void;
  onAdd: (branchId: string, anchor: { x: number; y: number }) => void;
  onRemove: (edgeId: string) => void;
  onFocus: (nodeId: string) => void;
}) {
  const config = node.data.config;
  const { message } = App.useApp();
  const cases = conditionCases(config);
  const visual = isVisualCondition(config);
  return (
    <div className="condition-branch-editor">
      {visual ? (
        <>
          {cases.map((item, index) => (
            <section className="condition-case" key={item.id}>
              <header className="condition-case-heading">
                <div className="condition-case-title">
                  <b>{index === 0 ? "IF" : "ELIF"}</b>
                  <span>CASE {index + 1}</span>
                </div>
                <Button
                  type="text"
                  htmlType="button"
                  disabled={cases.length === 1}
                  aria-label={`移除 CASE ${index + 1}`}
                  onClick={() => {
                    const count = edges.filter(
                      (edge) => edge.source === node.id && branchIdOf(edge) === item.id,
                    ).length;
                    onChange({ ...config, cases: cases.filter((other) => other.id !== item.id) });
                    if (count)
                      void message.info(`已移除 ${count} 条连接，下游节点保留；可撤销恢复`);
                  }}
                >
                  <DeleteOutlined /> 移除
                </Button>
              </header>
              <ConditionBuilder
                node={node}
                nodes={nodes}
                edges={edges}
                item={item}
                onChange={onChange}
              />
            </section>
          ))}
          <Button
            className="condition-add-elif"
            type="text"
            htmlType="button"
            disabled={cases.length >= 64}
            onClick={() => {
              onChange({ ...config, cases: [...cases, newConditionCase()] });
              requestAnimationFrame(() => {
                const container = document.querySelector(".workflow-inspector");
                const section = container?.querySelector(".condition-add-elif");
                if (container && section)
                  container.scrollTop +=
                    section.getBoundingClientRect().top -
                    container.getBoundingClientRect().top -
                    120;
              });
            }}
          >
            <PlusOutlined /> ELIF
          </Button>
          <section className="condition-else">
            <b>ELSE</b>
            <p>所有 IF / ELIF 条件均不满足时，执行此分支。</p>
          </section>
        </>
      ) : (
        <section className="condition-legacy">
          <b>IF / ELSE</b>
          <p>此节点使用原有表达式配置，运行行为保持。</p>
          <TemplateField
            label="条件表达式"
            value={String(config.expression ?? "true")}
            onChange={(expression) => onChange({ ...config, expression })}
            inputs={nodeInputs(node.data)}
            rows={4}
          />
        </section>
      )}
      <ConditionNextSteps
        node={node}
        nodes={nodes}
        edges={edges}
        onAdd={onAdd}
        onRemove={onRemove}
        onFocus={onFocus}
      />
      <Collapse
        ghost
        className="condition-advanced"
        items={[
          {
            key: "advanced",
            label: "高级：配置方式",
            children: (
              <>
                <p>
                  切换方式会移除当前分支连接，并保留下游节点；可撤销恢复。表达式不会自动转换为条件。
                </p>
                <Button
                  htmlType="button"
                  onClick={() =>
                    onChange(
                      visual
                        ? {
                            ...config,
                            mode: "expression",
                            expression:
                              typeof config.expression === "string" ? config.expression : "false",
                          }
                        : {
                            ...config,
                            mode: "visual",
                            cases: cases.length ? cases : [newConditionCase()],
                          },
                    )
                  }
                >
                  {visual ? "切换到表达式配置" : "使用可视化条件"}
                </Button>
              </>
            ),
          },
        ]}
      />
    </div>
  );
}
