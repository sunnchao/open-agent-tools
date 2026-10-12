import { Button, Checkbox, Flex, Form, Input, Select, Typography } from "antd";
import { useEffect, useState } from "react";
import {
  runVariables,
  similarVariableNames,
  validVariableName,
  type RunVariable,
  type VariableType,
} from "@open-agent-tools/workflow-contracts";
import { DeleteOutlined, PlusOutlined } from "../../lib/icons.js";
import { nextVariableName, variableNodes } from "./variables.js";
import { nodeInputs } from "./model.js";
import type { WorkflowNode } from "./types.js";

function DefaultValueField({
  variable,
  onChange,
}: {
  variable: RunVariable;
  onChange: (value: unknown) => void;
}) {
  const text =
    variable.defaultValue === undefined
      ? ""
      : typeof variable.defaultValue === "string"
        ? variable.defaultValue
        : JSON.stringify(variable.defaultValue);
  const [draft, setDraft] = useState(text);
  const [error, setError] = useState("");
  useEffect(() => {
    setDraft(text);
  }, [text]);
  return (
    <Form.Item
      label="默认值（可选）"
      validateStatus={error ? "error" : undefined}
      help={error || undefined}
    >
      <Input
        aria-label={`${variable.name} 默认值`}
        value={draft}
        placeholder={variable.type === "string" ? "留空表示无默认值" : "JSON 值，如 3、true、{}"}
        onChange={(event) => {
          const value = event.target.value;
          setDraft(value);
          try {
            onChange(
              value === ""
                ? undefined
                : variable.type === "string" || variable.type === "any"
                  ? value
                  : JSON.parse(value),
            );
            setError("");
          } catch {
            onChange(value);
            setError("请输入合法 JSON 值");
          }
        }}
      />
    </Form.Item>
  );
}
export function RunVariablesEditor({
  node,
  nodes,
  updateConfig,
  rename,
}: {
  node: WorkflowNode;
  nodes: WorkflowNode[];
  updateConfig: (key: string, value: unknown) => void;
  rename: (kind: "inputs" | "outputs" | "runVariables", index: number, name: string) => void;
}) {
  const variables = runVariables(variableNodes(nodes));
  const update = (index: number, patch: Partial<RunVariable>) =>
    updateConfig(
      "runVariables",
      variables.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    );
  const [renaming, setRenaming] = useState<{ index: number; value: string } | null>(null);
  return (
    <Flex vertical className="variable-bindings" aria-label="工作流入口变量">
      <Flex className="variable-group-head">
        <Typography.Text>入口变量 · {variables.length}</Typography.Text>
        <Button
          type="text"
          htmlType="button"
          onClick={() =>
            updateConfig("runVariables", [
              ...variables,
              {
                name: nextVariableName(
                  variables.map((item) => item.name),
                  "input",
                ),
                type: "string",
                required: true,
              },
            ])
          }
        >
          <PlusOutlined /> 创建变量
        </Button>
      </Flex>
      <Typography.Paragraph className="variable-help">
        在这里声明一次，其他节点通过选择引用。名称修改会同步入口绑定。
      </Typography.Paragraph>
      {!variables.length && (
        <Typography.Text className="variable-empty">
          暂无入口变量。创建后可在任何节点的“输入来源”中选择。
        </Typography.Text>
      )}
      {variables.map((variable, index) => {
        const uses = nodes.filter((item) =>
          nodeInputs(item.data).some(
            (input) => input.source.type === "run" && input.source.variable === variable.name,
          ),
        );
        const similar = similarVariableNames(
          variable.name,
          variables.map((item) => item.name),
        );
        const name = renaming?.index === index ? renaming.value : variable.name;
        const invalid =
          !validVariableName(name) ||
          variables.some((item, i) => i !== index && item.name === name);
        return (
          <Flex vertical className="variable-card" key={`${node.id}-${index}`}>
            <Flex className="variable-card-heading">
              <Form.Item
                label="变量名"
                className="variable-name-field"
                validateStatus={invalid ? "error" : undefined}
              >
                <Input
                  aria-label="入口变量名"
                  value={name}
                  aria-invalid={invalid}
                  onChange={(event) => setRenaming({ index, value: event.target.value })}
                  onBlur={() => {
                    if (renaming?.index === index && !invalid) {
                      rename("runVariables", index, name);
                      setRenaming(null);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
              </Form.Item>
              <Button
                type="text"
                htmlType="button"
                className="variable-delete"
                aria-label={`删除入口变量 ${variable.name}`}
                onClick={() =>
                  updateConfig(
                    "runVariables",
                    variables.filter((_, i) => i !== index),
                  )
                }
              >
                <DeleteOutlined />
              </Button>
            </Flex>
            <Flex className="variable-card-meta">
              <Flex vertical className="variable-type-field" gap={4}>
                <Typography.Text type="secondary">类型</Typography.Text>
                <Select
                  aria-label={`${variable.name} 类型`}
                  value={variable.type}
                  onChange={(value: VariableType) =>
                    update(index, {
                      type: value,
                      defaultValue: undefined,
                    })
                  }
                  options={["string", "number", "boolean", "object", "array", "any"].map(
                    (type) => ({ value: type, label: type === "any" ? "any · 任意类型" : type }),
                  )}
                />
              </Flex>
              <Checkbox
                className="variable-required"
                checked={variable.required !== false}
                onChange={(event) => update(index, { required: event.target.checked })}
              >
                必填
              </Checkbox>
            </Flex>
            <DefaultValueField
              key={`${index}-${variable.type}`}
              variable={variable}
              onChange={(defaultValue) => update(index, { defaultValue })}
            />
            {invalid && (
              <Typography.Text className="field-error">
                名称须唯一，以字母或下划线开头，仅使用字母、数字、下划线或 $。
              </Typography.Text>
            )}
            {similar.length > 0 && (
              <Typography.Text className="variable-help">
                与 {similar.join("、")} 名称相近，请核对。
              </Typography.Text>
            )}
            <Typography.Text className="variable-help">
              {uses.length
                ? `被 ${uses.length} 个节点引用：${uses.map((item) => item.data.label).join("、")}。删除后引用将标记为失效。`
                : "尚未被引用"}
            </Typography.Text>
          </Flex>
        );
      })}
    </Flex>
  );
}
