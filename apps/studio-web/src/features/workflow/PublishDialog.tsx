import { useEffect, useRef, useState } from "react";

export function PublishDialog({
  pending,
  error,
  onCancel,
  onPublish,
}: {
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onPublish: (notes: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [notes, setNotes] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="workflow-action-dialog"
      aria-labelledby="workflow-publish-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onCancel();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!pending) onPublish(notes);
        }}
      >
        <span className="settings-kicker">PUBLISH VERSION</span>
        <h2 id="workflow-publish-title">发布工作流</h2>
        <p className="muted-copy">保存当前草稿并创建不可变版本。</p>
        <label className="studio-field">
          <span>版本说明（可选）</span>
          <textarea
            autoFocus
            rows={5}
            value={notes}
            maxLength={2000}
            disabled={pending}
            placeholder="例如：修复 RAG 检索 topK 不生效"
            onChange={(event) => setNotes(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (!pending) onPublish(notes);
              }
            }}
          />
        </label>
        <p className="muted-copy">Enter 发布 · Shift+Enter 换行 · Esc 取消</p>
        {error ? (
          <p className="workflow-access-alert is-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="settings-modal-actions">
          <button
            className="studio-button secondary"
            type="button"
            disabled={pending}
            onClick={onCancel}
          >
            取消
          </button>
          <button className="studio-button primary" type="submit" disabled={pending}>
            {pending ? "发布中…" : "确认发布"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
