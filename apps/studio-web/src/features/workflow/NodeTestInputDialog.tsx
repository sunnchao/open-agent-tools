import { Alert, Button, Flex, Form, Input, Modal, Tooltip, Typography } from "antd";
import { nodeInputs } from "./model.js";
import { describeNodeTestInputSource } from "./nodeTest.js";
import type { WorkflowNode } from "./types.js";
import { CloseOutlined, PlayCircleOutlined } from "../../lib/icons.js";

export function NodeTestInputDialog({
  node,
  values,
  setValues,
  onCancel,
  onRun,
}: {
  node: WorkflowNode;
  values: Record<string, string>;
  setValues: (values: Record<string, string>) => void;
  onCancel: () => void;
  onRun: () => void;
}) {
  const inputs = nodeInputs(node.data);
  return (
    <Modal
      open
      centered
      title={`测试运行 · ${node.data.label}`}
      okText="运行当前节点"
      cancelText="取消"
      okButtonProps={{ icon: <PlayCircleOutlined /> }}
      onCancel={onCancel}
      onOk={onRun}
    >
      <Flex justify="space-between" align="center" style={{ marginBottom: 12 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          输入值只用于本次节点测试，支持字符串、数字和 JSON。NODE TEST
        </Typography.Text>
        <Tooltip title="关闭">
          <Button type="text" size="small" icon={<CloseOutlined />} aria-label="关闭" onClick={onCancel} />
        </Tooltip>
      </Flex>
      <Form layout="vertical" preserve={false}>
        {inputs.map((input, index) => (
          <Form.Item
            key={`${input.name}-${index}`}
            label={`${input.name} · ${describeNodeTestInputSource(input)}${input.required !== false ? " · 必填" : ""}`}
            style={{ marginBottom: 12 }}
          >
            <Input.TextArea
              rows={3}
                aria-label={`测试输入 ${input.name}`}
                value={values[input.name] ?? ""}
                onChange={(event) => setValues({ ...values, [input.name]: event.target.value })}
              />
          </Form.Item>
        ))}
      </Form>
      {inputs.length === 0 ? (
        <Alert type="info" showIcon message="该节点无需输入参数，可直接运行。" />
      ) : null}
    </Modal>
  );
}
