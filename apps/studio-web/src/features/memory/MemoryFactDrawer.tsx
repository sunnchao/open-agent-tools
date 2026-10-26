import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Descriptions, Drawer, Flex, Modal, Tag, Timeline, Typography } from "antd";
import {
  MEMORY_KIND_LABEL,
  MEMORY_SCOPE_LABEL,
  MEMORY_STATUS_LABEL,
  fetchMemoryFact,
  reviewMemoryFact,
  type MemoryFact,
} from "./api.js";

/** 详情抽屉：事实本体、版本链与审核操作。`factId` 由路由驱动，刷新可回到同一条。 */
export function MemoryFactDrawer({
  factId,
  onClose,
  onChanged,
}: {
  factId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [fact, setFact] = useState<MemoryFact | null>(null);
  const [history, setHistory] = useState<MemoryFact[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setError("");
    try {
      const detail = await fetchMemoryFact(id);
      setFact(detail.fact);
      setHistory(detail.history);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setFact(null);
      setHistory([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!factId) {
      setFact(null);
      setHistory([]);
      setError("");
      return;
    }
    void load(factId);
  }, [factId, load]);

  const review = (accepted: boolean) => {
    if (!fact) return;
    const submit = async () => {
      setBusy(true);
      try {
        await reviewMemoryFact(fact.id, accepted);
        onChanged();
        if (accepted) void load(fact.id);
        else onClose();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setBusy(false);
      }
    };
    if (accepted) {
      void submit();
      return;
    }
    // 拒绝是物理删除，且提议没有历史价值，必须二次确认。
    Modal.confirm({
      title: "拒绝这条记忆提议？",
      content: "拒绝会直接删除该提议，不可恢复。若只是想暂时不召回，保持待审核即可。",
      okText: "拒绝并删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: submit,
    });
  };

  return (
    <Drawer
      open={Boolean(factId)}
      onClose={onClose}
      width={560}
      title="记忆详情"
      destroyOnHidden
      extra={
        fact?.unreviewed ? (
          <Flex gap={8}>
            <Button type="primary" size="small" loading={busy} onClick={() => review(true)}>
              接受
            </Button>
            <Button danger size="small" loading={busy} onClick={() => review(false)}>
              拒绝
            </Button>
          </Flex>
        ) : null
      }
    >
      {error ? <Alert type="error" showIcon role="alert" message={error} /> : null}
      {loading ? <Typography.Text type="secondary">加载中…</Typography.Text> : null}

      {fact ? (
        <Flex vertical gap={16}>
          <Typography.Paragraph style={{ margin: 0 }} copyable={{ text: fact.id }}>
            {fact.body}
          </Typography.Paragraph>

          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="主体">{fact.subject}</Descriptions.Item>
            <Descriptions.Item label="作用域">
              {MEMORY_SCOPE_LABEL[fact.scopeKind]} · {fact.scopeKey}
            </Descriptions.Item>
            <Descriptions.Item label="类型">{MEMORY_KIND_LABEL[fact.kind]}</Descriptions.Item>
            <Descriptions.Item label="slug">{fact.slug}</Descriptions.Item>
            <Descriptions.Item label="状态">
              <Tag color={fact.status === "active" ? "green" : "default"}>
                {MEMORY_STATUS_LABEL[fact.status]}
              </Tag>
              {fact.unreviewed ? <Tag color="gold">待审核</Tag> : null}
            </Descriptions.Item>
            <Descriptions.Item label="置信度">{fact.confidence}</Descriptions.Item>
            <Descriptions.Item label="有效区间">
              {fact.validFrom ?? "未知"} → {fact.validTo ?? "至今"}
            </Descriptions.Item>
            <Descriptions.Item label="来源">
              {fact.sourceSessionId ? (
                <Typography.Text code>{fact.sourceSessionId}</Typography.Text>
              ) : (
                "—"
              )}
              {fact.sourceMessageId ? `#${fact.sourceMessageId}` : ""}
            </Descriptions.Item>
          </Descriptions>

          <div>
            <Typography.Text strong>版本链</Typography.Text>
            <Timeline
              style={{ marginTop: 12 }}
              items={history.map((item) => ({
                color: item.status === "active" ? "green" : "gray",
                children: (
                  <Flex vertical gap={2}>
                    <Typography.Text>{item.body}</Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {MEMORY_STATUS_LABEL[item.status]} · 记录于{" "}
                      {new Date(item.recordedAt).toLocaleString("zh-CN")}
                      {item.validFrom ? ` · 生效 ${item.validFrom}` : ""}
                    </Typography.Text>
                  </Flex>
                ),
              }))}
            />
          </div>
        </Flex>
      ) : null}
    </Drawer>
  );
}
