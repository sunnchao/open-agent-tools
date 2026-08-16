import { useState } from "react";
import { CloseOutlined, SearchOutlined } from "../../lib/icons.js";
import { iconByKind, palette } from "./palette.js";
import type { NodeKind } from "../../features/workflow/model.js";
import type { NodePickerState } from "./types.js";

export function NodePicker({
  state,
  hasStart,
  onChoose,
  onClose,
}: {
  state: NodePickerState;
  hasStart: boolean;
  onChoose: (kind: NodeKind) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const choices = palette.filter((item) => {
    if (state.edgeId && (item.kind === "start" || item.kind === "end")) return false;
    const normalized = query.trim().toLocaleLowerCase();
    return (
      !normalized ||
      `${item.label} ${item.description} ${item.group} ${item.kind}`
        .toLocaleLowerCase()
        .includes(normalized)
    );
  });
  const left = Math.max(12, Math.min(state.anchor.x - 170, window.innerWidth - 352));
  const top =
    state.anchor.y + 438 > window.innerHeight
      ? Math.max(12, state.anchor.y - 430)
      : state.anchor.y + 12;
  return (
    <div
      className="workflow-node-picker-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        className="workflow-node-picker"
        role="dialog"
        aria-modal="true"
        aria-label={state.edgeId ? "插入节点" : "添加节点"}
        style={{ left, top }}
      >
        <header>
          <div>
            <b>{state.edgeId ? "插入节点" : "添加节点"}</b>
            <small>{state.edgeId ? "原连接会自动拆分" : "添加到当前画布"}</small>
          </div>
          <button type="button" aria-label="关闭节点选择器" onClick={onClose}>
            <CloseOutlined />
          </button>
        </header>
        <label className="node-picker-search">
          <SearchOutlined />
          <input
            autoFocus
            value={query}
            placeholder="搜索节点"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
              if (event.key === "Enter" && choices[0]) onChoose(choices[0].kind);
            }}
          />
        </label>
        <div className="node-picker-list">
          {choices.map((item) => {
            const disabled = item.kind === "start" && hasStart;
            return (
              <button
                type="button"
                key={item.kind}
                className={`kind-${item.kind}`}
                disabled={disabled}
                title={disabled ? "工作流只能有一个开始节点" : item.description}
                onClick={() => onChoose(item.kind)}
              >
                <span>{iconByKind[item.kind]}</span>
                <span>
                  <b>{item.label}</b>
                  <small>{item.description}</small>
                </span>
                <code>{item.group}</code>
              </button>
            );
          })}
          {choices.length === 0 ? <div className="node-picker-empty">没有匹配的节点</div> : null}
        </div>
      </section>
    </div>
  );
}
