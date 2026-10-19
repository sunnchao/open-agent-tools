import { Alert, Button, Flex, Form, Input, Modal, Tooltip, Typography } from "antd";
import { prepareRunInputs, type RunVariable } from "@open-agent-tools/workflow-contracts";
import { useState } from "react";
import { CloseOutlined, PlayCircleOutlined } from "../../lib/icons.js";

export function RunInputDialog({
  variables,
  values,
  setValues,
  onCancel,
  onRun,
}: {
  variables: RunVariable[];
  values: Record<string, string>;
  setValues: (values: Record<string, string>) => void;
  onCancel: () => void;
  onRun: (input: Record<string, unknown>) => void;
}) {
  const [errors, setErrors] = useState<string[]>([]);
  const submit = () => {
    const parsed: Record<string, unknown> = {};
    const invalid: string[] = [];
    for (const variable of variables) {
      const text = values[variable.name] ?? "";
      if (text === "") continue;
      try {
        parsed[variable.name] =
          variable.type === "string" || variable.type === "any" ? text : JSON.parse(text);
      } catch {
        invalid.push(`${variable.name} 请输入合法的 ${variable.type} 值`);
      }
    }
    const result = prepareRunInputs(variables, parsed);
    const next = [...invalid, ...result.errors];
    setErrors(next);
    if (!next.length) onRun(result.input);
  };
  return (
    <Modal
      open
      centered
      title="填写运行变量"
      okText="开始运行"
      cancelText="取消"
      okButtonProps={{ icon: <PlayCircleOutlined /> }}
      onCancel={onCancel}
      onOk={submit}
    >
      <Flex justify="space-between" align="center" style={{ marginBottom: 12 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          参数来自开始节点的入口声明。留空时使用默认值。RUN INPUTS
        </Typography.Text>
        <Tooltip title="关闭">
          <Button type="text" size="small" icon={<CloseOutlined />} aria-label="关闭" onClick={onCancel} />
        </Tooltip>
      </Flex>
      <Form layout="vertical" preserve={false}>
        {variables.map((variable) => (
          <Form.Item
            key={variable.name}
            label={`${variable.name} · ${variable.type} · ${variable.required !== false ? "必填" : "可选"}`}
            style={{ marginBottom: 12 }}
          >
            <Input
                value={values[variable.name] ?? ""}
                onChange={(event) => setValues({ ...values, [variable.name]: event.target.value })}
                placeholder={
                  variable.defaultValue !== undefined
                    ? `默认：${typeof variable.defaultValue === "string" ? variable.defaultValue : JSON.stringify(variable.defaultValue)}`
                    : variable.type === "string" || variable.type === "any"
                      ? "输入文本"
                      : "输入 JSON 值"
                }
              />
          </Form.Item>
        ))}
      </Form>
      {errors.length > 0 ? <Alert type="error" showIcon message={errors.join("；")} role="alert" /> : null}
    </Modal>
  );
}
