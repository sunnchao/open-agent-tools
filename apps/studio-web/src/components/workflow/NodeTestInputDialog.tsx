import { CloseOutlined, PlayCircleOutlined } from "../../lib/icons.js";
import { nodeInputs } from "../../features/workflow/model.js";
import { describeNodeTestInputSource } from "../../features/workflow/nodeTest.js";
import type { WorkflowNode } from "./types.js";

export function NodeTestInputDialog({
  node,
  values,
  setValues,
  onCancel,
  onRun,
}: {
  node: WorkflowNode;
  values: Record<string, string>;
  setValues: (values: Record<string, string>) => void;
  onCancel: () => void;
  onRun: () => void;
}) {
  const inputs = nodeInputs(node.data);
  return (
    <div className="settings-modal-backdrop" role="presentation">
      <div
        className="run-input-dialog node-test-input-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="node-test-input-title"
      >
        <div className="settings-modal-head">
          <div>
            <span className="settings-kicker">NODE TEST</span>
            <h2 id="node-test-input-title">测试运行 · {node.data.label}</h2>
          </div>
          <button type="button" aria-label="关闭" onClick={onCancel}>
            <CloseOutlined />
          </button>
        </div>
        <p className="muted-copy">输入值只用于本次节点测试，支持字符串、数字和 JSON。</p>
        <div className="node-test-input-fields">
          {inputs.map((input, index) => (
            <label className="node-test-input-field" key={`${input.name}-${index}`}>
              <span>
                <b>{input.name}</b>
                <code>{describeNodeTestInputSource(input)}</code>
                {input.required !== false ? <small>必填</small> : null}
              </span>
              <textarea
                rows={3}
                aria-label={`测试输入 ${input.name}`}
                value={values[input.name] ?? ""}
                autoFocus={index === 0}
                onChange={(event) => setValues({ ...values, [input.name]: event.target.value })}
              />
            </label>
          ))}
        </div>
        <div className="settings-modal-actions">
          <button className="studio-button secondary" type="button" onClick={onCancel}>
            取消
          </button>
          <button className="studio-button run" type="button" onClick={onRun}>
            <PlayCircleOutlined /> 运行当前节点
          </button>
        </div>
      </div>
    </div>
  );
}
