import { useId, useRef, useState } from "react";
import {
  similarVariableNames,
  templateReferences,
  templateStrings,
} from "@open-agent-tools/workflow-contracts";
import { replaceTemplateReference } from "./variables.js";
import type { NodeInputBinding } from "./model.js";
import { VariableSelect } from "./VariableSelect.js";

export function TemplateField({
  label,
  value,
  onChange,
  inputs,
  rows = 3,
  hint,
  json = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  inputs: NodeInputBinding[];
  rows?: number;
  hint?: string;
  json?: boolean;
}) {
  const id = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const selection = useRef({ start: value.length, end: value.length });
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const names = inputs.map((input) => input.name).filter(Boolean);
  const matches = names.filter((name) => name.toLowerCase().includes(query.toLowerCase()));
  let strings = [value];
  if (json) {
    try {
      strings = templateStrings(JSON.parse(value));
    } catch {
      strings = [];
    }
  }
  const missing = [
    ...new Set(strings.flatMap(templateReferences).filter((name) => !names.includes(name))),
  ];
  const insert = (name: string) => {
    const { start, end } = selection.current;
    const prefix = value.slice(0, start);
    const partial = prefix.match(/\{\{[^{}]*$/);
    const from = partial ? start - partial[0].length : start;
    const to = partial && value.slice(end, end + 2) === "}}" ? end + 2 : end;
    const token = `{{${name}}}`;
    onChange(value.slice(0, from) + token + value.slice(to));
    setOpen(false);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(from + token.length, from + token.length);
    });
  };
  return (
    <div className="studio-field workflow-template-field">
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        ref={textarea}
        rows={rows}
        value={value}
        aria-invalid={missing.length > 0}
        aria-describedby={missing.length ? `${id}-error` : undefined}
        aria-controls={open ? `${id}-suggestions` : undefined}
        onSelect={(event) => {
          selection.current = {
            start: event.currentTarget.selectionStart,
            end: event.currentTarget.selectionEnd,
          };
        }}
        onChange={(event) => {
          const next = event.target.value;
          selection.current = {
            start: event.target.selectionStart,
            end: event.target.selectionEnd,
          };
          const match = next.slice(0, event.target.selectionStart).match(/\{\{([^{}]*)$/);
          setOpen(Boolean(match));
          setQuery(match?.[1] ?? "");
          setActive(0);
          onChange(next);
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (!open) return;
          if (event.key === "Escape") {
            setOpen(false);
            event.preventDefault();
          }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setActive((current) =>
              Math.max(
                0,
                Math.min(matches.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)),
              ),
            );
          }
          if ((event.key === "Enter" || event.key === "Tab") && matches[active]) {
            event.preventDefault();
            insert(matches[active]!);
          }
        }}
      />
      {open && (
        <div className="variable-suggestions" id={`${id}-suggestions`}>
          {matches.length ? (
            matches.map((name, index) => (
              <button
                key={name}
                type="button"
                className={active === index ? "is-active" : ""}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insert(name)}
              >
                {name}
              </button>
            ))
          ) : (
            <small>没有匹配的已绑定变量</small>
          )}
        </div>
      )}
      <VariableSelect
        label={`${label}插入变量`}
        placeholder="插入变量…"
        options={names.map((name) => ({ value: name, label: name, group: "本节点输入" }))}
        onChange={insert}
      />
      {missing.length > 0 && (
        <div className="field-error" id={`${id}-error`}>
          <small>未绑定变量：{missing.join("、")}。请从“插入变量”中选择。</small>
          {missing.flatMap((name) =>
            similarVariableNames(name, names).map((suggestion) => (
              <button
                key={`${name}-${suggestion}`}
                type="button"
                className="variable-text-button"
                onClick={() => onChange(replaceTemplateReference(value, name, suggestion, json))}
              >
                改为 {suggestion}
              </button>
            )),
          )}
        </div>
      )}
      {hint && <small className="field-help">{hint}</small>}
    </div>
  );
}
