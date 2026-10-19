import { Modal, Typography } from "antd";

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
  return (
    <Modal
      open
      centered
      title={title}
      okText={confirmLabel}
      cancelText="取消"
      onOk={onConfirm}
      onCancel={onCancel}
    >
      <Typography.Paragraph type="secondary">{detail}</Typography.Paragraph>
    </Modal>
  );
}
