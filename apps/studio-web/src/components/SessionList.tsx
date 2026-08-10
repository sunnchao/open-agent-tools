import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Input, Popconfirm, Space } from "antd";
import { DeleteOutlined, EditOutlined, SearchOutlined } from "../lib/icons.js";
import type { Session } from "../types.js";

interface SessionListProps {
  sessions: Session[];
  activeId: string;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
}

function groupLabel(ts?: number): string {
  if (!ts) return "更早";
  const d = new Date(ts);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  if (d.getTime() >= startOfToday) return "今天";
  if (d.getTime() >= startOfYesterday) return "昨天";
  return "更早";
}

export function SessionList({
  sessions,
  activeId,
  onSelect,
  onDelete,
  onRename,
}: SessionListProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [keyword, setKeyword] = useState("");
  const inputRef = useRef<InputRefLike>(null);

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  const startEdit = (s: Session) => {
    setEditingId(s.id);
    setEditValue(s.title);
  };

  const commitEdit = () => {
    if (editingId) {
      onRename(editingId, editValue.trim() || "未命名对话");
    }
    setEditingId(null);
  };

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    const list = kw ? sessions.filter((s) => s.title.toLowerCase().includes(kw)) : sessions;
    const order = { 今天: 0, 昨天: 1, 更早: 2 } as const;
    const groups = new Map<string, Session[]>();
    for (const s of list) {
      const label = groupLabel(s.updatedAt);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label)!.push(s);
    }
    return [...groups.entries()].sort((a, b) => order[a[0] as keyof typeof order] - order[b[0] as keyof typeof order]);
  }, [sessions, keyword]);

  return (
    <div className="session-list">
      <div style={{ padding: "4px 6px 8px" }}>
        <Input
          allowClear
          size="small"
          prefix={<SearchOutlined />}
          placeholder="搜索对话"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
      </div>
      {filtered.length === 0 ? (
        <div style={{ padding: "24px 12px", textAlign: "center", color: "#9299a3", fontSize: 12 }}>
          没有匹配的对话
        </div>
      ) : (
        filtered.map(([label, items]) => (
          <div key={label}>
            <div
              style={{
                padding: "8px 10px 4px",
                fontSize: 11,
                fontWeight: 600,
                color: "#9299a3",
                letterSpacing: 0.5,
              }}
            >
              {label}
            </div>
            {items.map((s) => (
              <div
                key={s.id}
                className={`session-item ${s.id === activeId ? "session-item--active" : ""}`}
                onClick={() => onSelect(s.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") onSelect(s.id);
                }}
              >
                {editingId === s.id ? (
                  <Input
                    ref={inputRef as never}
                    size="small"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitEdit();
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="session-item__title">{s.title}</span>
                )}
                <Space size={0} className="session-item__actions" onClick={(e) => e.stopPropagation()}>
                  <Button
                    type="text"
                    size="small"
                    icon={<EditOutlined />}
                    title="重命名"
                    onClick={() => startEdit(s)}
                  />
                  <Popconfirm
                    title="删除这段对话？"
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => onDelete(s.id)}
                  >
                    <Button type="text" size="small" danger icon={<DeleteOutlined />} title="删除" />
                  </Popconfirm>
                </Space>
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}

/** Minimal Input ref surface used for focus/select. */
interface InputRefLike {
  focus: () => void;
  select: () => void;
}
