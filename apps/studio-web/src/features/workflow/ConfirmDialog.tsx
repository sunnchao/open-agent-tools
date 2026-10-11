import { useEffect, useRef } from "react";

export function ConfirmDialog({
  title,
  detail,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  detail: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="workflow-action-dialog"
      aria-labelledby="workflow-confirm-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id="workflow-confirm-title">{title}</h2>
      <p className="muted-copy">{detail}</p>
      <div className="settings-modal-actions">
        <button autoFocus className="studio-button secondary" type="button" onClick={onCancel}>
          取消
        </button>
        <button className="studio-button primary" type="button" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
