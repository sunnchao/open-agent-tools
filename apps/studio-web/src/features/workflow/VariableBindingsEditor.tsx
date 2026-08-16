import { DeleteOutlined, PlusOutlined } from "../../lib/icons.js";
import { nodeInputs, nodeOutputs } from "./model.js";
import type {
  NodeInputBinding,
  NodeOutputBinding,
} from "./model.js";
import type { Edge } from "@xyflow/react";
import type { WorkflowNode } from "./types.js";

export function VariableBindingsEditor({
  node,
  nodes,
  edges,
  updateConfig,
}: {
  node: WorkflowNode;
  nodes: WorkflowNode[];
  edges: Edge[];
  updateConfig: (key: string, value: unknown) => void;
}) {
  const inputs = nodeInputs(node.data);
  const outputs = nodeOutputs(node.data);
  const predecessors = edges
    .filter((edge) => edge.target === node.id)
    .map((edge) => nodes.find((item) => item.id === edge.source))
    .filter((item): item is WorkflowNode => Boolean(item));
  const predecessorOutputs = predecessors.flatMap((item) =>
    nodeOutputs(item.data).map((output) => ({
      nodeId: item.id,
      nodeLabel: item.data.label,
      output: output.name,
    })),
  );
  const updateInputs = (next: NodeInputBinding[]) => updateConfig("inputs", next);
  const updateOutputs = (next: NodeOutputBinding[]) => updateConfig("outputs", next);
  const sourceValue = (source: NodeInputBinding["source"]) =>
    source.type === "run"
      ? `run:${source.variable}`
      : source.type === "node"
        ? `node:${source.nodeId}:${source.output}`
        : "literal";
  const updateSource = (input: NodeInputBinding, value: string): NodeInputBinding => {
    if (value === "literal") return { ...input, source: { type: "literal", value: "" } };
    if (value.startsWith("node:")) {
      const [, nodeId, output] = value.split(":");
      return { ...input, source: { type: "node", nodeId: nodeId ?? "", output: output ?? "" } };
    }
    return { ...input, source: { type: "run", variable: value.slice(4) } };
  };
  return (
    <div className="variable-bindings">
      <div className="variable-group-head">
        <span>输入变量</span>
        <button
          type="button"
          onClick={() =>
            updateInputs([
              ...inputs,
              {
                name: `input${inputs.length + 1}`,
                source: { type: "run", variable: "" },
                required: true,
              },
            ])
          }
        >
          <PlusOutlined /> 添加
        </button>
      </div>
      {inputs.length === 0 ? (
        <small className="variable-empty">无输入绑定。可添加入口变量、固定值或前置节点输出。</small>
      ) : (
        inputs.map((input, index) => (
          <div className="variable-row" key={`${input.name}-${index}`}>
            <input
              className="variable-name"
              value={input.name}
              aria-label="输入变量名"
              onChange={(event) =>
                updateInputs(
                  inputs.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, name: event.target.value } : item,
                  ),
                )
              }
            />
            <select
              value={sourceValue(input.source)}
              aria-label="输入来源"
              onChange={(event) =>
                updateInputs(
                  inputs.map((item, itemIndex) =>
                    itemIndex === index ? updateSource(item, event.target.value) : item,
                  ),
                )
              }
            >
              <option value="literal">固定值</option>
              <option value={`run:${input.source.type === "run" ? input.source.variable : ""}`}>
                运行输入
              </option>
              {predecessorOutputs.map((item) => (
                <option
                  key={`${item.nodeId}:${item.output}`}
                  value={`node:${item.nodeId}:${item.output}`}
                >
                  {item.nodeLabel} · {item.output}
                </option>
              ))}
            </select>
            {input.source.type === "literal" ? (
              <input
                value={String(input.source.value ?? "")}
                aria-label="固定值"
                onChange={(event) =>
                  updateInputs(
                    inputs.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, source: { type: "literal", value: event.target.value } }
                        : item,
                    ),
                  )
                }
              />
            ) : null}
            {input.source.type === "run" ? (
              <input
                value={input.source.variable}
                aria-label="运行输入变量"
                placeholder="入口变量名"
                onChange={(event) =>
                  updateInputs(
                    inputs.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, source: { type: "run", variable: event.target.value } }
                        : item,
                    ),
                  )
                }
              />
            ) : null}
            <label className="variable-required" title="必填">
              <input
                type="checkbox"
                checked={input.required !== false}
                onChange={(event) =>
                  updateInputs(
                    inputs.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, required: event.target.checked } : item,
                    ),
                  )
                }
              />{" "}
              必填
            </label>
            <button
              type="button"
              className="variable-delete"
              title="删除输入"
              aria-label="删除输入"
              onClick={() => updateInputs(inputs.filter((_, itemIndex) => itemIndex !== index))}
            >
              <DeleteOutlined />
            </button>
          </div>
        ))
      )}
      <div className="variable-group-head">
        <span>输出变量</span>
        <button
          type="button"
          onClick={() =>
            updateOutputs([
              ...outputs,
              { name: `output${outputs.length + 1}`, selector: "$result" },
            ])
          }
        >
          <PlusOutlined /> 添加
        </button>
      </div>
      {outputs.length === 0 ? (
        <small className="variable-empty">无输出绑定。节点结果不会传给下游。</small>
      ) : (
        outputs.map((output, index) => (
          <div className="variable-row output-row" key={`${output.name}-${index}`}>
            <input
              className="variable-name"
              value={output.name}
              aria-label="输出变量名"
              onChange={(event) =>
                updateOutputs(
                  outputs.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, name: event.target.value } : item,
                  ),
                )
              }
            />
            <input
              className="mono-input"
              value={output.selector}
              aria-label="输出选择器"
              onChange={(event) =>
                updateOutputs(
                  outputs.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, selector: event.target.value } : item,
                  ),
                )
              }
            />
            <button
              type="button"
              className="variable-delete"
              title="删除输出"
              aria-label="删除输出"
              onClick={() => updateOutputs(outputs.filter((_, itemIndex) => itemIndex !== index))}
            >
              <DeleteOutlined />
            </button>
          </div>
        ))
      )}
    </div>
  );
}
