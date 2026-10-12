import { Button, Input, InputNumber, Segmented, Select } from "antd";
import {
  conditionCases,
  conditionConfigIssues,
  conditionNeedsValue,
  operatorsForType,
  type ConditionCase,
  type ConditionOperator,
  type ConditionRule,
} from "@open-agent-tools/workflow-contracts";
import { DeleteOutlined, PlusOutlined } from "../../lib/icons.js";
import { VariableSelect } from "./VariableSelect.js";
import { nodeInputs } from "./model.js";
import {
  boundRuleType,
  conditionVariableOptions,
  ruleSource,
  selectConditionVariable,
} from "./condition.js";
import type { WorkflowNode } from "./types.js";
import type { Edge } from "@xyflow/react";

export function ConditionBuilder({
  node,
  nodes,
  edges,
  item,
  onChange,
}: {
  node: WorkflowNode;
  nodes: WorkflowNode[];
  edges: Edge[];
  item: ConditionCase;
  onChange: (config: Record<string, unknown>) => void;
}) {
  const options = conditionVariableOptions(node, nodes, edges);
  const caseLabel = `CASE ${conditionCases(node.data.config).findIndex((current) => current.id === item.id) + 1}`;
  const issues = conditionConfigIssues(
    { ...node.data.config, cases: [item] },
    new Map(
      nodeInputs(node.data).map((input) => [input.name, boundRuleType(node, input.name, nodes)]),
    ),
  );
  const update = (patch: Partial<ConditionCase>) =>
    onChange({
      ...node.data.config,
      cases: conditionCases(node.data.config).map((current) =>
        current.id === item.id ? { ...current, ...patch } : current,
      ),
    });
  const updateRule = (index: number, patch: Partial<ConditionRule>) =>
    update({ rules: item.rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)) });
  const addRule = () => update({ rules: [...item.rules, { variable: "", operator: "is" }] });
  return (
    <div className="condition-builder">
      <Button className="condition-add-rule" htmlType="button" onClick={addRule}>
        <PlusOutlined /> 添加条件
      </Button>
      {item.rules.length > 1 && (
        <Segmented
          size="small"
          aria-label={`${caseLabel} 条件逻辑`}
          value={item.logicalOperator ?? "and"}
          options={[
            { label: "全部满足 AND", value: "and" },
            { label: "任一满足 OR", value: "or" },
          ]}
          onChange={(value) => update({ logicalOperator: value as "and" | "or" })}
        />
      )}
      {item.rules.map((rule, index) => {
        const type = boundRuleType(node, rule.variable, nodes);
        const available = operatorsForType(type);
        const validOperator = available.some((operator) => operator.value === rule.operator);
        const source = ruleSource(node, rule.variable);
        const valueType =
          typeof rule.value === "string" && /\{\{/.test(rule.value)
            ? "any"
            : ["contains", "not_contains", "start_with", "end_with"].includes(rule.operator) &&
                type !== "array"
              ? "string"
              : type;
        return (
          <div className="condition-rule" key={`${item.id}-${index}`}>
            {index > 0 && (
              <span className="condition-rule-logic">
                {(item.logicalOperator ?? "and").toUpperCase()}
              </span>
            )}
            <div className="condition-rule-fields">
              <VariableSelect
                label={`${caseLabel} 条件 ${index + 1} 变量`}
                value={source ?? (rule.variable ? rule.variable : undefined)}
                options={options}
                autoFocus={!rule.variable && index === item.rules.length - 1}
                onChange={(selected) => {
                  const config = selectConditionVariable(
                    node.data.config,
                    item.id,
                    index,
                    selected,
                  );
                  const nextNode = { ...node, data: { ...node.data, config } };
                  const nextRule = conditionCases(config).find((current) => current.id === item.id)!
                    .rules[index]!;
                  const nextType = boundRuleType(nextNode, nextRule.variable, nodes);
                  const nextOperators = operatorsForType(nextType);
                  const operator = nextOperators.some((current) => current.value === rule.operator)
                    ? rule.operator
                    : nextOperators[0]!.value;
                  const { value: _value, ...rest } = nextRule;
                  void _value;
                  const normalized = { ...rest, operator } as ConditionRule;
                  config.cases = conditionCases(config).map((current) =>
                    current.id === item.id
                      ? {
                          ...current,
                          rules: current.rules.map((other, i) =>
                            i === index ? normalized : other,
                          ),
                        }
                      : current,
                  );
                  onChange(config);
                }}
              />
              <Select
                aria-label={`${caseLabel} 条件 ${index + 1} 运算符`}
                value={rule.operator}
                status={validOperator ? undefined : "error"}
                options={
                  validOperator
                    ? available
                    : [{ value: rule.operator, label: "类型不兼容，请重新选择" }, ...available]
                }
                onChange={(operator: ConditionOperator) => updateRule(index, { operator })}
              />
              {conditionNeedsValue(rule.operator) &&
                (valueType === "boolean" ? (
                  <Select
                    aria-label={`${caseLabel} 条件 ${index + 1} 比较值`}
                    placeholder="选择布尔值"
                    value={typeof rule.value === "boolean" ? String(rule.value) : undefined}
                    options={[
                      { value: "true", label: "True" },
                      { value: "false", label: "False" },
                    ]}
                    onChange={(value) => updateRule(index, { value: value === "true" })}
                  />
                ) : valueType === "number" ? (
                  <InputNumber
                    aria-label={`${caseLabel} 条件 ${index + 1} 比较值`}
                    placeholder="输入数值"
                    value={typeof rule.value === "number" ? rule.value : null}
                    onChange={(value) => {
                      if (value === null) {
                        update({
                          rules: item.rules.map((other, i) => {
                            if (i !== index) return other;
                            const next = { ...other };
                            delete next.value;
                            return next;
                          }),
                        });
                      } else updateRule(index, { value });
                    }}
                  />
                ) : (
                  <Input
                    aria-label={`${caseLabel} 条件 ${index + 1} 比较值`}
                    placeholder={
                      type === "any" || type === "array"
                        ? "比较值（可输入 JSON 标量）"
                        : "输入比较文本"
                    }
                    value={
                      typeof rule.value === "string"
                        ? rule.value
                        : rule.value === undefined
                          ? ""
                          : JSON.stringify(rule.value)
                    }
                    onChange={(event) => {
                      let value: unknown = event.target.value;
                      if (type === "any" || type === "array") {
                        try {
                          value = JSON.parse(event.target.value);
                        } catch {
                          /* Keep text as entered. */
                        }
                      }
                      updateRule(index, { value });
                    }}
                  />
                ))}
              <Button
                className="condition-delete-rule"
                type="text"
                htmlType="button"
                aria-label={`删除 ${caseLabel} 条件 ${index + 1}`}
                onClick={() => update({ rules: item.rules.filter((_, i) => i !== index) })}
              >
                <DeleteOutlined />
              </Button>
            </div>
            {issues
              .filter((issue) => issue.ruleIndex === index)
              .map((issue) => (
                <span className="field-error" key={issue.code}>
                  {issue.message.replace(/^CASE 1/, caseLabel)}
                </span>
              ))}
            {rule.variable && type === "any" && (
              <span className="field-help">运行时检查变量类型</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
