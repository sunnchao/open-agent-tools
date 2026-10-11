import { useEffect, useRef } from "react";
import type { WorkflowResumeCheckpoint } from "@open-agent-tools/workflow-contracts";

export function ResumeDialog({
  checkpoint,
  onCancel,
  onRun,
}: {
  checkpoint: WorkflowResumeCheckpoint;
  onCancel: () => void;
  onRun: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="workflow-action-dialog"
      aria-labelledby="workflow-resume-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <span className="settings-kicker">RESUME FROM HISTORY</span>
      <h2 id="workflow-resume-title">确认从 {checkpoint.fromNodeId} 续跑</h2>
      <p className="muted-copy">
        入口输入沿用历史值；从该节点开始执行当前草稿，将复用这些上游输出：
      </p>
      <div className="workflow-resume-cache">
        {Object.entries(checkpoint.cachedNodes).map(([id, cached]) => (
          <section key={id}>
            <b>{id}</b>
            <pre>{JSON.stringify(cached.outputs, null, 2).slice(0, 1500)}</pre>
          </section>
        ))}
        {!Object.keys(checkpoint.cachedNodes).length ? (
          <p>没有上游缓存，本次将从入口重新执行。</p>
        ) : null}
      </div>
      <div className="settings-modal-actions">
        <button className="studio-button secondary" autoFocus type="button" onClick={onCancel}>
          取消
        </button>
        <button className="studio-button run" type="button" onClick={onRun}>
          确认续跑
        </button>
      </div>
    </dialog>
  );
}
