import { useEffect, useRef, useState } from "react";
import { Button, Input, Popconfirm, Space } from "antd";
import { DeleteOutlined, EditOutlined } from "@ant-design/icons";
import type { Session } from "../types.js";

interface SessionListProps {
  sessions: Session[];
  activeId: string;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
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
      onRename(editingId, editValue.trim() || "Untitled");
    }
    setEditingId(null);
  };

  return (
    <div className="session-list">
      {sessions.map((s) => (
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
              title="Rename"
              onClick={() => startEdit(s)}
            />
            <Popconfirm
              title="Delete this chat?"
              okText="Delete"
              cancelText="Cancel"
              okButtonProps={{ danger: true }}
              onConfirm={() => onDelete(s.id)}
            >
              <Button type="text" size="small" danger icon={<DeleteOutlined />} title="Delete" />
            </Popconfirm>
          </Space>
        </div>
      ))}
    </div>
  );
}

/** Minimal Input ref surface used for focus/select. */
interface InputRefLike {
  focus: () => void;
  select: () => void;
}
