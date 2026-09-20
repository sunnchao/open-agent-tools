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
    <label className="studio-field">
      <span>默认值（可选）</span>
      <input
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
      {error && <small className="field-error">{error}</small>}
    </label>
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
    <section className="variable-bindings" aria-label="工作流入口变量">
      <div className="variable-group-head">
        <span>入口变量 · {variables.length}</span>
        <button
          type="button"
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
        </button>
      </div>
      <p className="variable-help">
        在这里声明一次，其他节点通过选择引用。名称修改会同步入口绑定。
      </p>
      {!variables.length && (
        <small className="variable-empty">
          暂无入口变量。创建后可在任何节点的“输入来源”中选择。
        </small>
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
          <div className="variable-card" key={`${node.id}-${index}`}>
            <div className="variable-card-heading">
              <label className="studio-field">
                <span>变量名</span>
                <input
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
              </label>
              <button
                type="button"
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
              </button>
            </div>
            <div className="variable-card-meta">
              <label>
                类型{" "}
                <select
                  aria-label={`${variable.name} 类型`}
                  value={variable.type}
                  onChange={(event) =>
                    update(index, {
                      type: event.target.value as VariableType,
                      defaultValue: undefined,
                    })
                  }
                >
                  {(["string", "number", "boolean", "object", "array", "any"] as const).map(
                    (type) => (
                      <option value={type} key={type}>
                        {type === "any" ? "any · 任意类型" : type}
                      </option>
                    ),
                  )}
                </select>
              </label>
              <label className="variable-required">
                <input
                  type="checkbox"
                  checked={variable.required !== false}
                  onChange={(event) => update(index, { required: event.target.checked })}
                />
                必填
              </label>
            </div>
            <DefaultValueField
              key={`${index}-${variable.type}`}
              variable={variable}
              onChange={(defaultValue) => update(index, { defaultValue })}
            />
            {invalid && (
              <small className="field-error">
                名称须唯一，以字母或下划线开头，仅使用字母、数字、下划线或 $。
              </small>
            )}
            {similar.length > 0 && (
              <small className="variable-help">与 {similar.join("、")} 名称相近，请核对。</small>
            )}
            <small className="variable-help">
              {uses.length
                ? `被 ${uses.length} 个节点引用：${uses.map((item) => item.data.label).join("、")}。删除后引用将标记为失效。`
                : "尚未被引用"}
            </small>
          </div>
        );
      })}
    </section>
  );
}
