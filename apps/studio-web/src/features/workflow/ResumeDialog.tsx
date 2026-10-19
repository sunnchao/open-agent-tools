import { Collapse, Modal, Typography } from "antd";
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
  const entries = Object.entries(checkpoint.cachedNodes);
  return (
    <Modal
      open
      centered
      title={`确认从 ${checkpoint.fromNodeId} 续跑`}
      okText="确认续跑"
      cancelText="取消"
      onOk={onRun}
      onCancel={onCancel}
    >
      <Typography.Paragraph type="secondary">
        入口输入沿用历史值；从该节点开始执行当前草稿，将复用这些上游输出：
      </Typography.Paragraph>
      {entries.length === 0 ? (
        <Typography.Paragraph type="secondary">
          没有上游缓存，本次将从入口重新执行。
        </Typography.Paragraph>
      ) : (
        <Collapse
          size="small"
          items={entries.map(([id, cached]) => ({
            key: id,
            label: id,
            children: (
              <Typography.Paragraph code style={{ whiteSpace: "pre-wrap", marginBottom: 0 }}>
                {JSON.stringify(cached.outputs, null, 2).slice(0, 1500)}
              </Typography.Paragraph>
            ),
          }))}
        />
      )}
    </Modal>
  );
}
