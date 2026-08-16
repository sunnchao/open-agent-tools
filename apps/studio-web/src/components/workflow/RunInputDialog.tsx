import { CloseOutlined, PlayCircleOutlined } from "../../lib/icons.js";

export function RunInputDialog({
  names,
  values,
  setValues,
  onCancel,
  onRun,
}: {
  names: string[];
  values: Record<string, string>;
  setValues: (values: Record<string, string>) => void;
  onCancel: () => void;
  onRun: () => void;
}) {
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
        <p className="muted-copy">这些值会注入到 Workflow 的入口变量绑定。</p>
        <div className="run-input-fields">
          {names.map((name) => (
            <label className="studio-field" key={name}>
              <span>{name}</span>
              <input
                value={values[name] ?? ""}
                onChange={(event) => setValues({ ...values, [name]: event.target.value })}
                autoFocus={name === names[0]}
              />
            </label>
          ))}
        </div>
        <div className="settings-modal-actions">
          <button className="studio-button secondary" type="button" onClick={onCancel}>
            取消
          </button>
          <button className="studio-button run" type="button" onClick={onRun}>
            <PlayCircleOutlined /> 开始运行
          </button>
        </div>
      </div>
    </div>
  );
}
