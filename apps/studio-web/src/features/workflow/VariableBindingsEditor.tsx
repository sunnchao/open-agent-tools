import { useState } from "react";
import {
  runVariables,
  selectorIssue,
  similarVariableNames,
  validVariableName,
} from "@open-agent-tools/workflow-contracts";
import { DeleteOutlined, PlusOutlined } from "../../lib/icons.js";
import { nodeInputs, nodeOutputs, type NodeInputBinding, type NodeOutputBinding } from "./model.js";
import type { Edge } from "@xyflow/react";
import type { WorkflowNode } from "./types.js";
import {
  inputOptions,
  outputOptions,
  sourceKey,
  nextVariableName,
  variableNodes,
} from "./variables.js";
import { VariableSelect } from "./VariableSelect.js";

function BindingName({
  name,
  label,
  taken,
  rename,
}: {
  name: string;
  label: string;
  taken: string[];
  rename: (name: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      title="名称须唯一，仅使用字母、数字、下划线或 $，不能以数字开头。无效名称不会保存。"
      className="variable-name"
      value={draft ?? name}
      aria-label={label}
      aria-invalid={!validVariableName(draft ?? name) || taken.includes(draft ?? name)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== null && validVariableName(draft) && !taken.includes(draft)) {
          rename(draft);
          setDraft(null);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}
function OutputSelector({
  node,
  output,
  sample,
  onChange,
}: {
  node: WorkflowNode;
  output: NodeOutputBinding;
  sample?: unknown;
  onChange: (selector: string) => void;
}) {
  const options = outputOptions(node, sample);
  const [advanced, setAdvanced] = useState(false);
  const unknown = !options.some((item) => item.value === output.selector);
  const error = selectorIssue(variableNodes([node])[0]!, output.selector);
  return (
    <div className="variable-selector">
      <VariableSelect
        label="输出取值"
        value={output.selector}
        options={
          unknown && !error
            ? [...options, { value: output.selector, label: output.selector, group: "自定义路径" }]
            : options
        }
        onChange={onChange}
        placeholder="选择输出字段"
      />
      <button type="button" className="variable-text-button" onClick={() => setAdvanced(!advanced)}>
        {advanced ? "收起路径编辑" : "高级：编辑路径"}
      </button>
      {(advanced || unknown) && (
        <input
          className="mono-input"
          value={output.selector}
          aria-label="输出选择器"
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {error && <small className="field-error">{error}</small>}
    </div>
  );
}
export function VariableBindingsEditor({
  node,
  nodes,
  edges,
  updateConfig,
  rename,
  onManageVariables,
  sample,
}: {
  node: WorkflowNode;
  nodes: WorkflowNode[];
  edges: Edge[];
  updateConfig: (key: string, value: unknown) => void;
  rename: (kind: "inputs" | "outputs" | "runVariables", index: number, name: string) => void;
  onManageVariables: () => void;
  sample?: unknown;
}) {
  const inputs = nodeInputs(node.data);
  const outputs = nodeOutputs(node.data);
  const options = inputOptions(node, nodes, edges);
  const updateInput = (index: number, patch: Partial<NodeInputBinding>) =>
    updateConfig(
      "inputs",
      inputs.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    );
  const updateOutput = (index: number, selector: string) =>
    updateConfig(
      "outputs",
      outputs.map((item, i) =>
        i === index
          ? {
              ...item,
              selector,
              name:
                /^output\d*$/.test(item.name) &&
                item.selector === "$result" &&
                !nodes.some((candidate) =>
                  nodeInputs(candidate.data).some(
                    (input) =>
                      input.source.type === "node" &&
                      input.source.nodeId === node.id &&
                      input.source.output === item.name,
                  ),
                )
                  ? nextVariableName(
                      outputs.filter((_, j) => j !== index).map((other) => other.name),
                      selector.split(".").at(-1)!.replace(/^\$/, ""),
                    )
                  : item.name,
            }
          : item,
      ),
    );
  return (
    <div className="variable-bindings">
      <div className="variable-group-head">
        <span>输入变量</span>
        <button
          type="button"
          onClick={() =>
            updateConfig("inputs", [
              ...inputs,
              {
                name: nextVariableName(
                  inputs.map((item) => item.name),
                  "input",
                ),
                source: { type: "run", variable: "" },
                required: true,
              },
            ])
          }
        >
          <PlusOutlined /> 添加
        </button>
      </div>
      <button type="button" className="variable-text-button" onClick={onManageVariables}>
        管理 / 创建入口变量
      </button>
      {!inputs.length && (
        <small className="variable-empty">
          添加输入，再选择入口变量、固定值或直接前置节点输出。
        </small>
      )}
      {inputs.map((input, index) => {
        const value = sourceKey(input.source);
        const missing = !options.some((option) => option.value === value);
        const runSuggestions =
          input.source.type === "run"
            ? similarVariableNames(
                input.source.variable,
                runVariables(variableNodes(nodes)).map((item) => item.name),
              )
            : [];
        const nodeSuggestions =
          input.source.type === "node"
            ? options.filter((option) => {
                if (!option.group.startsWith("前置节点 · ")) return false;
                const source = JSON.parse(option.value) as NodeInputBinding["source"];
                return (
                  source.type === "node" &&
                  input.source.type === "node" &&
                  (source.output === input.source.output ||
                    similarVariableNames(input.source.output, [source.output]).length > 0)
                );
              })
            : [];
        const duplicate = inputs.some((item, i) => i !== index && item.name === input.name);
        return (
          <div className="variable-card" key={`${node.id}-input-${index}`}>
            <div className="variable-card-heading">
              <BindingName
                name={input.name}
                taken={inputs.filter((_, i) => i !== index).map((item) => item.name)}
                label="输入变量名"
                rename={(name) => rename("inputs", index, name)}
              />
              <label className="variable-required">
                <input
                  type="checkbox"
                  checked={input.required !== false}
                  onChange={(event) => updateInput(index, { required: event.target.checked })}
                />
                必填
              </label>
              <button
                type="button"
                className="variable-delete"
                aria-label="删除输入"
                onClick={() =>
                  updateConfig(
                    "inputs",
                    inputs.filter((_, i) => i !== index),
                  )
                }
              >
                <DeleteOutlined />
              </button>
            </div>
            <VariableSelect
              label="输入来源"
              value={input.source.type === "run" && !input.source.variable ? undefined : value}
              options={options}
              onChange={(selected) => {
                const source = JSON.parse(selected) as NodeInputBinding["source"];
                // Name automatically on first selection; existing aliases and templates are retained.
                const suggested =
                  source.type === "run"
                    ? source.variable
                    : source.type === "node"
                      ? source.output
                      : input.name;
                const name =
                  input.source.type === "run" &&
                  !input.source.variable &&
                  /^input\d*$/.test(input.name)
                    ? nextVariableName(
                        inputs.filter((_, i) => i !== index).map((item) => item.name),
                        suggested,
                      )
                    : input.name;
                const declaration =
                  source.type === "run"
                    ? runVariables(variableNodes(nodes)).find(
                        (item) => item.name === source.variable,
                      )
                    : undefined;
                updateInput(index, {
                  source,
                  name,
                  ...(declaration ? { required: declaration.required !== false } : {}),
                });
              }}
            />
            {input.source.type === "literal" && (
              <input
                value={String(input.source.value ?? "")}
                aria-label="固定值"
                placeholder="输入固定文本"
                onChange={(event) =>
                  updateInput(index, { source: { type: "literal", value: event.target.value } })
                }
              />
            )}
            {missing && (
              <div className="field-error">
                <small>请选择有效来源；失效引用需要重新绑定。</small>
                {runSuggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    className="variable-text-button"
                    onClick={() =>
                      updateInput(index, { source: { type: "run", variable: suggestion } })
                    }
                  >
                    重绑为 {suggestion}
                  </button>
                ))}
                {nodeSuggestions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className="variable-text-button"
                    onClick={() =>
                      updateInput(index, {
                        source: JSON.parse(option.value) as NodeInputBinding["source"],
                      })
                    }
                  >
                    重绑为 {option.label}
                  </button>
                ))}
              </div>
            )}
            {(!validVariableName(input.name) || duplicate) && (
              <small className="field-error">变量名称无效或重复。</small>
            )}
          </div>
        );
      })}
      <div className="variable-group-head">
        <span>输出变量</span>
        <button
          type="button"
          onClick={() =>
            updateConfig("outputs", [
              ...outputs,
              {
                name: nextVariableName(
                  outputs.map((item) => item.name),
                  "output",
                ),
                selector: "$result",
              },
            ])
          }
        >
          <PlusOutlined /> 添加
        </button>
      </div>
      {!outputs.length && (
        <small className="variable-empty">选择结果或输入作为输出，供下游节点使用。</small>
      )}
      {outputs.map((output, index) => {
        const uses = nodes.filter((item) =>
          nodeInputs(item.data).some(
            (input) =>
              input.source.type === "node" &&
              input.source.nodeId === node.id &&
              input.source.output === output.name,
          ),
        );
        return (
          <div className="variable-card" key={`${node.id}-output-${index}`}>
            <div className="variable-card-heading">
              <BindingName
                name={output.name}
                taken={outputs.filter((_, i) => i !== index).map((item) => item.name)}
                label="输出变量名"
                rename={(name) => rename("outputs", index, name)}
              />
              <button
                type="button"
                className="variable-delete"
                aria-label="删除输出"
                onClick={() =>
                  updateConfig(
                    "outputs",
                    outputs.filter((_, i) => i !== index),
                  )
                }
              >
                <DeleteOutlined />
              </button>
            </div>
            <OutputSelector
              node={node}
              output={output}
              sample={sample}
              onChange={(selector) => updateOutput(index, selector)}
            />
            {(!validVariableName(output.name) ||
              outputs.some((item, i) => i !== index && item.name === output.name)) && (
              <small className="field-error">变量名称无效或重复。</small>
            )}
            {uses.length > 0 && (
              <small className="variable-help">
                被 {uses.length} 个节点引用：{uses.map((item) => item.data.label).join("、")}
                。删除后引用将标记为失效。
              </small>
            )}
          </div>
        );
      })}
    </div>
  );
}
