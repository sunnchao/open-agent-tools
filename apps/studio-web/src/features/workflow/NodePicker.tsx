import { useState } from "react";
import { CloseOutlined, SearchOutlined } from "../../lib/icons.js";
import { iconByKind, palette } from "./palette.js";
import type { NodeKind } from "./model.js";
import type { NodePickerState } from "./types.js";

export function NodePicker({
  state,
  hasStart,
  onChoose,
  onClose,
  existingNodes = [],
  onChooseExisting,
}: {
  state: NodePickerState;
  hasStart: boolean;
  onChoose: (kind: NodeKind) => void;
  onClose: () => void;
  existingNodes?: Array<{ id: string; label: string; kind?: NodeKind }>;
  onChooseExisting?: (nodeId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLocaleLowerCase();
  const existingChoices = existingNodes.filter(
    (node) => !normalized || `${node.label} ${node.id}`.toLocaleLowerCase().includes(normalized),
  );
  const choices = palette.filter((item) => {
    if (state.edgeId && (item.kind === "start" || item.kind === "end")) return false;
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
        aria-label={state.sourceNodeId ? "选择下一节点" : state.edgeId ? "插入节点" : "添加节点"}
        style={{ left, top }}
      >
        <header>
          <div>
            <b>{state.sourceNodeId ? "选择下一节点" : state.edgeId ? "插入节点" : "添加节点"}</b>
            <small>
              {state.sourceNodeId
                ? "选择后自动连接当前分支"
                : state.edgeId
                  ? "原连接会自动拆分"
                  : "添加到当前画布"}
            </small>
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
              if (event.key === "Enter") {
                if (state.sourceNodeId && existingChoices[0] && onChooseExisting)
                  onChooseExisting(existingChoices[0].id);
                else {
                  const first = choices.find(
                    (item) => item.kind !== "start" || (!hasStart && !state.sourceNodeId),
                  );
                  if (first) onChoose(first.kind);
                }
              }
            }}
          />
        </label>
        <div className="node-picker-list">
          {state.sourceNodeId && existingNodes.length > 0 && (
            <>
              <span className="node-picker-section-label">已有节点</span>
              {existingChoices.map((node) => (
                <button
                  type="button"
                  className={`kind-${node.kind ?? "input"}`}
                  key={node.id}
                  onClick={() => onChooseExisting?.(node.id)}
                >
                  <span aria-hidden="true">{iconByKind[node.kind ?? "input"]}</span>
                  <span>
                    <b>{node.label}</b>
                    <small>{node.id}</small>
                  </span>
                  <code>连接</code>
                </button>
              ))}
              <span className="node-picker-section-label">新建节点</span>
            </>
          )}
          {choices.map((item) => {
            const disabled = item.kind === "start" && (hasStart || Boolean(state.sourceNodeId));
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
          {choices.length === 0 && existingChoices.length === 0 ? (
            <div className="node-picker-empty">没有匹配的节点</div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
