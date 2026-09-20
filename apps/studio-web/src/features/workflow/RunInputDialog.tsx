import { useState } from "react";
import { prepareRunInputs, type RunVariable } from "@open-agent-tools/workflow-contracts";
import { CloseOutlined, PlayCircleOutlined } from "../../lib/icons.js";

export function RunInputDialog({
  variables,
  values,
  setValues,
  onCancel,
  onRun,
}: {
  variables: RunVariable[];
  values: Record<string, string>;
  setValues: (values: Record<string, string>) => void;
  onCancel: () => void;
  onRun: (input: Record<string, unknown>) => void;
}) {
  const [errors, setErrors] = useState<string[]>([]);
  const submit = () => {
    const parsed: Record<string, unknown> = {};
    const invalid: string[] = [];
    for (const variable of variables) {
      const text = values[variable.name] ?? "";
      if (text === "") continue;
      try {
        parsed[variable.name] =
          variable.type === "string" || variable.type === "any" ? text : JSON.parse(text);
      } catch {
        invalid.push(`${variable.name} 请输入合法的 ${variable.type} 值`);
      }
    }
    const result = prepareRunInputs(variables, parsed);
    const next = [...invalid, ...result.errors];
    setErrors(next);
    if (!next.length) onRun(result.input);
  };
  return (
    <div className="settings-modal-backdrop" role="presentation">
      <div
        className="run-input-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-input-title"
      >
        <div className="settings-modal-head">
          <div>
            <span className="settings-kicker">RUN INPUTS</span>
            <h2 id="run-input-title">填写运行变量</h2>
          </div>
          <button type="button" aria-label="关闭" onClick={onCancel}>
            <CloseOutlined />
          </button>
        </div>
        <p className="muted-copy">参数来自开始节点的入口声明。留空时使用默认值。</p>
        <div className="run-input-fields">
          {variables.map((variable, index) => (
            <label className="studio-field" key={variable.name}>
              <span>
                {variable.name}
                <small>
                  {variable.type} · {variable.required !== false ? "必填" : "可选"}
                </small>
              </span>
              <input
                value={values[variable.name] ?? ""}
                onChange={(event) => setValues({ ...values, [variable.name]: event.target.value })}
                autoFocus={index === 0}
                placeholder={
                  variable.defaultValue !== undefined
                    ? `默认：${typeof variable.defaultValue === "string" ? variable.defaultValue : JSON.stringify(variable.defaultValue)}`
                    : variable.type === "string" || variable.type === "any"
                      ? "输入文本"
                      : "输入 JSON 值"
                }
              />
            </label>
          ))}
        </div>
        {errors.length > 0 && (
          <div className="node-resource-state is-error" role="alert">
            {errors.join("；")}
          </div>
        )}
        <div className="settings-modal-actions">
          <button className="studio-button secondary" type="button" onClick={onCancel}>
            取消
          </button>
          <button className="studio-button run" type="button" onClick={submit}>
            <PlayCircleOutlined /> 开始运行
          </button>
        </div>
      </div>
    </div>
  );
}
