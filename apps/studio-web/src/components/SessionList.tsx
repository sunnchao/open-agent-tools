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

function previewText(session: Session): string {
  const last = [...session.messages].reverse().find((message) => message.content.trim());
  return last?.content.replace(/\s+/g, " ").slice(0, 72) ?? "暂无消息";
}

function timeLabel(ts?: number): string {
  if (!ts) return "—";
  const date = new Date(ts);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (date.getTime() >= startOfToday) {
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  const yesterday = new Date(startOfToday - 24 * 60 * 60 * 1000);
  if (date >= yesterday) {
    return `昨天 ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
  }
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
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
      <div className="session-list__search">
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
        <div className="session-list__empty">没有匹配的对话</div>
      ) : (
        filtered.map(([label, items]) => (
          <div key={label}>
            <div className="session-group">{label}</div>
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
                  <>
                    <span className="session-item__title" title={s.title}>
                      {s.title}
                    </span>
                    <span className="session-item__preview">{previewText(s)}</span>
                    <span className="session-item__meta">
                      <span>{timeLabel(s.updatedAt)}</span>
                      <span>·</span>
                      <span>{s.messages.length} 条</span>
                    </span>
                  </>
                )}
                <Space size={0} className="session-item__actions" onClick={(e) => e.stopPropagation()}>
                  <Button
                    type="text"
                    size="small"
                    icon={<EditOutlined />}
                    title="重命名"
                    aria-label="重命名会话"
                    onClick={() => startEdit(s)}
                  />
                  <Popconfirm
                    title="删除这段对话？"
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => onDelete(s.id)}
                  >
                    <Button
                      type="text"
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      title="删除"
                      aria-label="删除会话"
                    />
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
