import { useState } from "react";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Flex,
  Input,
  Modal,
  Radio,
  Space,
  Typography,
} from "antd";
import { forgetMemoryFacts, previewForget, type ForgetPreview } from "./api.js";

type Target = "person" | "session";

/** 遗忘面板：先预览、再二次确认，删除范围与保留范围都必须说清。 */
export function MemoryForgetPanel({ onForgotten }: { onForgotten: () => void }) {
  const [target, setTarget] = useState<Target>("person");
  const [value, setValue] = useState("");
  const [preview, setPreview] = useState<ForgetPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ facts: number; summaries: number; lineage: number } | null>(
    null,
  );
  // 确认弹窗为受控组件：输入错误必须留在弹窗内可见，不能静默关闭。
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmInput, setConfirmInput] = useState("");
  const [confirmError, setConfirmError] = useState("");

  const trimmed = value.trim();
  const selector = target === "person" ? { personId: trimmed } : { sessionId: trimmed };

  const runPreview = async () => {
    if (!trimmed) {
      setError("请先填写目标 ID");
      return;
    }
    setLoading(true);
    setError("");
    setResult(null);
    setPreview(null);
    try {
      setPreview(await previewForget(selector));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  const confirmForget = () => {
    if (!preview) return;
    setConfirmOpen(true);
  };

  const submitForget = async () => {
    if (!preview) return;
    const suffix = trimmed.slice(-6);
    if (confirmInput.trim() !== suffix) {
      setConfirmError(`输入不匹配，需要「${suffix}」`);
      return;
    }
    setLoading(true);
    try {
      const deleted = await forgetMemoryFacts(selector);
      setResult(deleted);
      setPreview(null);
      setValue("");
      setConfirmOpen(false);
      setConfirmInput("");
      setConfirmError("");
      onForgotten();
    } catch (reason) {
      setConfirmError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Flex vertical gap={12}>
      <Alert
        type="info"
        showIcon
        message="删记忆 ≠ 删聊天记录 ≠ 删审计"
        description="遗忘只清理记忆派生数据（事实、摘要、索引、血缘）。会话原文与 IM 审计由各自的删除与保留策略负责，需要单独处理。"
      />

      <Card size="small" title="选择范围">
        <Flex vertical gap={12}>
          <Radio.Group
            value={target}
            onChange={(event) => {
              setTarget(event.target.value as Target);
              setPreview(null);
              setResult(null);
              setValue("");
            }}
            aria-label="遗忘目标类型"
          >
            <Radio.Button value="person">按人</Radio.Button>
            <Radio.Button value="session">按会话</Radio.Button>
          </Radio.Group>

          <Input
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setPreview(null);
              setResult(null);
            }}
            placeholder={
              target === "person"
                ? "person:feishu:oc_xxx:ou_xxx"
                : "feishu:oc_xxx:u:ou_xxx"
            }
            aria-label={target === "person" ? "个人作用域 ID" : "会话 ID"}
            allowClear
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {target === "person"
              ? "个人作用域 ID 可在记忆详情的「作用域」字段复制。"
              : "会话 ID 可在审计中心的 IM 会话详情中复制。"}
          </Typography.Text>

          <Space>
            <Button loading={loading} onClick={() => void runPreview()}>
              预览影响
            </Button>
            <Button danger disabled={!preview} onClick={confirmForget}>
              执行遗忘
            </Button>
          </Space>
        </Flex>
      </Card>

      {error ? <Alert type="error" showIcon role="alert" message={error} /> : null}

      {preview ? (
        <Card size="small" title="预览结果">
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="事实">{preview.facts} 条</Descriptions.Item>
            <Descriptions.Item label="会话摘要">{preview.summaries} 条</Descriptions.Item>
            <Descriptions.Item label="血缘记录">{preview.lineage} 条</Descriptions.Item>
            <Descriptions.Item label="不受影响">
              {preview.untouched.join("、")}
            </Descriptions.Item>
          </Descriptions>
          {preview.facts === 0 && preview.summaries === 0 && preview.lineage === 0 ? (
            <Alert
              style={{ marginTop: 8 }}
              type="warning"
              showIcon
              message="没有匹配到可删除的记忆，请确认 ID 是否正确。"
            />
          ) : null}
        </Card>
      ) : null}

      {result ? (
        <Alert
          type="success"
          showIcon
          message="遗忘完成"
          description={`已删除 ${result.facts} 条事实、${result.summaries} 条摘要、${result.lineage} 条血缘。`}
        />
      ) : null}

      <Modal
        open={confirmOpen}
        title="确认遗忘这些记忆？"
        okText="永久删除"
        cancelText="取消"
        okButtonProps={{
          danger: true,
          loading,
          // 输入不匹配时禁用：比“点了再报错”更直接，也不会出现静默关闭。
          disabled: confirmInput.trim() !== trimmed.slice(-6),
        }}
        onOk={() => void submitForget()}
        onCancel={() => {
          setConfirmOpen(false);
          setConfirmInput("");
          setConfirmError("");
        }}
        destroyOnHidden
      >
        {preview ? (
          <Flex vertical gap={8}>
            <Typography.Text>
              将永久删除 {preview.facts} 条事实、{preview.summaries} 条摘要、
              {preview.lineage} 条血缘，且不可恢复。
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              不会被删除：{preview.untouched.join("、")}。
            </Typography.Text>
            <Typography.Text>
              请输入目标 ID 末 6 位「{trimmed.slice(-6)}」以确认：
            </Typography.Text>
            <Input
              aria-label="确认输入"
              value={confirmInput}
              status={confirmInput.trim() === trimmed.slice(-6) ? undefined : "warning"}
              onChange={(event) => {
                setConfirmInput(event.target.value);
                setConfirmError("");
              }}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {confirmInput.trim() === trimmed.slice(-6)
                ? "校验通过，可以永久删除。"
                : "输入匹配后「永久删除」才可点击。"}
            </Typography.Text>
            {confirmError ? (
              <Typography.Text type="danger" role="alert">
                {confirmError}
              </Typography.Text>
            ) : null}
          </Flex>
        ) : null}
      </Modal>
    </Flex>
  );
}
