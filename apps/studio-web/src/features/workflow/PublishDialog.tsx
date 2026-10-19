import { Alert, Form, Input, Modal, Typography } from "antd";
import { useState } from "react";

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
  const [notes, setNotes] = useState("");
  return (
    <Modal
      open
      centered
      title="发布工作流"
      okText={pending ? "发布中…" : "确认发布"}
      cancelText="取消"
      confirmLoading={pending}
      onCancel={() => {
        if (!pending) onCancel();
      }}
      onOk={() => {
        if (!pending) onPublish(notes);
      }}
    >
      <Typography.Paragraph type="secondary">
        保存当前草稿并创建不可变版本。PUBLISH VERSION
      </Typography.Paragraph>
      <Form layout="vertical" preserve={false}>
        <Form.Item label="版本说明（可选）" style={{ marginBottom: 8 }}>
          <Input.TextArea
            rows={5}
            value={notes}
            maxLength={2000}
            disabled={pending}
            placeholder="例如：修复 RAG 检索 topK 不生效"
            onChange={(event) => setNotes(event.target.value)}
          />
        </Form.Item>
      </Form>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        Enter 发布 · Shift+Enter 换行 · Esc 取消
      </Typography.Paragraph>
      {error ? <Alert type="error" showIcon message={error} role="alert" /> : null}
    </Modal>
  );
}
