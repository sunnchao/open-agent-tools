import { useState } from "react";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Flex,
  Form,
  InputNumber,
  Select,
  Typography,
} from "antd";
import { CheckCircleFilled, EditOutlined, LoadingOutlined } from "../../lib/icons.js";
import {
  McpApiError,
  updateVersionLimits,
  type McpExecutionLimits,
  type McpVersion,
} from "./api.js";

export function VersionLimits({
  serviceId,
  version,
  onRefresh,
}: {
  serviceId: string;
  version: McpVersion;
  onRefresh: (versionId?: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState<{
    limits: McpExecutionLimits;
    revision: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const editable = ["DRAFT", "FAILED", "READY"].includes(version.status);
  const limits = version.limits;

  const save = async (values: {
    timeoutMs: number;
    memoryMb: number;
    cpuMillis: number;
    network: McpExecutionLimits["network"];
  }) => {
    if (!editing || !editable || busy) return;
    const next: McpExecutionLimits = {
      timeoutMs: Number(values.timeoutMs),
      memoryMb: Number(values.memoryMb),
      cpuMillis: Number(values.cpuMillis),
      network: values.network,
    };
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await updateVersionLimits(serviceId, version.id, editing.revision, next);
      await onRefresh(version.id);
      setEditing(null);
      setNotice("运行限制已保存");
    } catch (reason) {
      if (reason instanceof McpApiError && reason.code === "CONFLICT") {
        await onRefresh(version.id).catch(() => undefined);
        setEditing(null);
        setError("版本已更新，请重新编辑运行限制。");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      size="small"
      title="运行限制"
      extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>应用于当前版本的所有 Tool</Typography.Text>}
      actions={
        limits && editable && !editing
          ? [
              <Button
                key="edit"
                type="link"
                size="small"
                icon={<EditOutlined />}
                onClick={() => {
                  setEditing({ limits: { ...limits }, revision: version.revision });
                  setError("");
                  setNotice("");
                }}
              >
                编辑限制
              </Button>,
            ]
          : undefined
      }
    >
      {!limits ? (
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
          {version.status === "VALIDATING"
            ? "代码包检查完成后，将显示 mcp.json 中的运行限制。"
            : version.tools.length === 0
              ? "上传 Tool 代码包后，可在这里查看和调整运行限制。"
              : "当前版本尚未配置运行限制。"}
        </Typography.Paragraph>
      ) : editing ? (
        <Form
          layout="vertical"
          preserve={false}
          disabled={busy || !editable}
          initialValues={editing.limits}
          onFinish={(values) => void save(values)}
        >
          <Form.Item
            name="timeoutMs"
            label="超时 (ms)"
            extra="1–120,000 ms"
            rules={[{ required: true, message: "请填写超时时间" }]}
          >
              <InputNumber
                min={1}
                max={120_000}
                step={1}
                style={{ width: "100%" }}
              />
            </Form.Item>
          <Form.Item
            name="memoryMb"
            label="内存 (MiB)"
            extra="32–4,096 MiB"
            rules={[{ required: true, message: "请填写内存" }]}
          >
              <InputNumber
                min={32}
                max={4_096}
                step={1}
                style={{ width: "100%" }}
              />
            </Form.Item>
          <Form.Item
            name="cpuMillis"
            label="CPU (millicores)"
            extra="1,000 millicores = 1 核"
            rules={[{ required: true, message: "请填写 CPU" }]}
          >
              <InputNumber
                min={10}
                max={8_000}
                step={1}
                style={{ width: "100%" }}
              />
            </Form.Item>
          <Form.Item
            name="network"
            label="网络"
            extra="bridge 允许容器访问外部网络。"
            rules={[{ required: true, message: "请选择网络模式" }]}
          >
              <Select
                options={[
                  { value: "none", label: "none · 禁止联网" },
                  { value: "bridge", label: "bridge · 允许联网" },
                ]}
              />
            </Form.Item>
            <Flex gap={8} justify="flex-end">
              <Button
                disabled={busy}
                onClick={() => {
                  setEditing(null);
                  setError("");
                }}
              >
                取消
              </Button>
              <Button
                type="primary"
                htmlType="submit"
                icon={busy ? <LoadingOutlined spin /> : <CheckCircleFilled />}
                loading={busy}
                disabled={busy || !editable}
              >
                保存限制
              </Button>
            </Flex>
        </Form>
      ) : (
        <Descriptions size="small" column={1} bordered>
          <Descriptions.Item label="超时">
            {limits.timeoutMs.toLocaleString()} <Typography.Text type="secondary">ms</Typography.Text>
          </Descriptions.Item>
          <Descriptions.Item label="内存">
            {limits.memoryMb.toLocaleString()} <Typography.Text type="secondary">MiB</Typography.Text>
          </Descriptions.Item>
          <Descriptions.Item label="CPU">
            {limits.cpuMillis.toLocaleString()} <Typography.Text type="secondary">millicores</Typography.Text>
          </Descriptions.Item>
          <Descriptions.Item label="网络">
            {limits.network}{" "}
            <Typography.Text type="secondary">
              {limits.network === "bridge" ? "允许联网" : "禁止联网"}
            </Typography.Text>
          </Descriptions.Item>
        </Descriptions>
      )}
      {limits && !editable ? (
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          {version.status === "VALIDATING" || version.status === "BUILDING"
            ? "检查或构建完成后可修改运行限制。"
            : "已发布版本只读，创建草稿后可修改。"}
        </Typography.Paragraph>
      ) : null}
      {notice ? <Alert showIcon type="success" message={notice} style={{ marginTop: 8 }} /> : null}
      {error ? <Alert showIcon type="error" message={error} role="alert" style={{ marginTop: 8 }} /> : null}
    </Card>
  );
}
