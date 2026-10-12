import { Select } from "antd";
import type { VariableOption } from "./variables.js";

/** A closed, searchable list: search text can never become an accidental declaration. */
export function VariableSelect({
  value,
  options,
  onChange,
  label,
  placeholder = "选择变量",
  autoFocus = false,
}: {
  value?: string;
  options: VariableOption[];
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const invalid = Boolean(value && !options.some((option) => option.value === value));
  let invalidLabel = value ?? "";
  if (invalid) {
    try {
      const source = JSON.parse(value!) as {
        type: string;
        variable?: string;
        nodeId?: string;
        output?: string;
      };
      invalidLabel =
        source.type === "run"
          ? `运行输入 · ${source.variable}`
          : `${source.nodeId} · ${source.output}`;
    } catch {
      /* Output paths are already readable. */
    }
  }
  const visible = invalid
    ? [{ value: value!, label: `已失效 · ${invalidLabel}`, group: "需要修复" }, ...options]
    : options;
  const groups = [...new Set(visible.map((option) => option.group))];
  return (
    <Select
      className="workflow-variable-select"
      autoFocus={autoFocus}
      aria-label={label}
      value={value || null}
      placeholder={placeholder}
      status={invalid ? "error" : undefined}
      showSearch={{ optionFilterProp: "label" }}
      options={groups.map((group) => ({
        label: group,
        options: visible.filter((option) => option.group === group),
      }))}
      onChange={onChange}
      notFoundContent="没有匹配的变量，请先在开始节点声明或配置前置节点输出"
      popupMatchSelectWidth={false}
    />
  );
}
