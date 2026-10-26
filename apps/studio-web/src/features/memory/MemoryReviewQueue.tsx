import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Empty,
  Flex,
  Modal,
  Skeleton,
  Tag,
  Typography,
} from "antd";
import { ReloadOutlined } from "../../lib/icons.js";
import {
  MEMORY_KIND_LABEL,
  fetchMemoryFacts,
  reviewMemoryFact,
  reviewMemoryFacts,
  type MemoryFact,
} from "./api.js";

/** 待审核队列：按写入时间正序，支持单条与批量操作。 */
export function MemoryReviewQueue({ onOpenFact }: { onOpenFact: (id: string) => void }) {
  const [facts, setFacts] = useState<MemoryFact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const page = await fetchMemoryFacts({
        status: "active",
        includeUnreviewed: true,
        limit: 100,
      });
      // 队列只关心待审核，且老的最先处理。
      setFacts(
        page.facts
          .filter((fact) => fact.unreviewed)
          .sort((left, right) => left.recordedAt - right.recordedAt),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, revision]);

  const accept = async (fact: MemoryFact) => {
    setBusyId(fact.id);
    setNotice("");
    try {
      await reviewMemoryFact(fact.id, true);
      setFacts((current) => current.filter((item) => item.id !== fact.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyId(null);
    }
  };

  const reject = (fact: MemoryFact) => {
    Modal.confirm({
      title: "拒绝这条记忆提议？",
      content: "拒绝会直接删除该提议，不可恢复。若只是想暂时不召回，保持待审核即可。",
      okText: "拒绝并删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        setBusyId(fact.id);
        try {
          await reviewMemoryFact(fact.id, false);
          setFacts((current) => current.filter((item) => item.id !== fact.id));
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
          setBusyId(null);
        }
      },
    });
  };

  const acceptAll = async () => {
    setBatchBusy(true);
    setNotice("");
    setError("");
    try {
      const result = await reviewMemoryFacts(
        facts.map((fact) => fact.id),
        true,
      );
      const failedIds = new Set(result.failed.map((item) => item.id));
      setFacts((current) => current.filter((fact) => failedIds.has(fact.id)));
      setNotice(
        `已接受 ${result.succeeded.length} 条` +
          (result.failed.length > 0 ? `，失败 ${result.failed.length} 条` : ""),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBatchBusy(false);
    }
  };

  return (
    <Flex vertical gap={12}>
      <Flex gap={8} align="center" wrap>
        <Typography.Text type="secondary">待审核 {facts.length} 条</Typography.Text>
        <Button icon={<ReloadOutlined />} size="small" onClick={() => setRevision((v) => v + 1)}>
          刷新
        </Button>
        <Button
          size="small"
          type="primary"
          disabled={facts.length === 0}
          loading={batchBusy}
          onClick={() => void acceptAll()}
        >
          全部接受
        </Button>
      </Flex>

      {error ? (
        <Alert
          type="error"
          showIcon
          role="alert"
          message={error}
          action={
            <Button size="small" onClick={() => setRevision((value) => value + 1)}>
              重试
            </Button>
          }
        />
      ) : null}
      {notice ? <Alert type="success" showIcon message={notice} /> : null}

      {loading ? (
        <Skeleton active paragraph={{ rows: 4 }} />
      ) : facts.length === 0 ? (
        <Empty
          description={
            <Flex vertical gap={4}>
              <Typography.Text>没有待审核的记忆</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                抽取产生的新事实会出现在这里，审核通过后才会被召回。
              </Typography.Text>
            </Flex>
          }
        />
      ) : (
        <Flex vertical gap={8}>
          {facts.map((fact) => (
            <Card
              key={fact.id}
              size="small"
              title={
                <Flex gap={6} wrap align="center">
                  <Typography.Text code>{fact.slug}</Typography.Text>
                  <Tag>{MEMORY_KIND_LABEL[fact.kind]}</Tag>
                  <Tag color={fact.confidence === "high" ? "green" : "default"}>
                    {fact.confidence}
                  </Tag>
                </Flex>
              }
              extra={
                <Flex gap={4}>
                  <Button
                    type="link"
                    size="small"
                    onClick={() => onOpenFact(fact.id)}
                    aria-label={`查看 ${fact.slug} 详情`}
                  >
                    详情
                  </Button>
                  <Button
                    type="primary"
                    size="small"
                    loading={busyId === fact.id}
                    onClick={() => void accept(fact)}
                  >
                    接受
                  </Button>
                  <Button danger size="small" onClick={() => reject(fact)}>
                    拒绝
                  </Button>
                </Flex>
              }
            >
              <Flex vertical gap={6}>
                <Typography.Paragraph style={{ margin: 0 }}>{fact.body}</Typography.Paragraph>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  主体 {fact.subject}
                  {fact.sourceSessionId ? ` · 来源 ${fact.sourceSessionId}` : ""}
                  {` · ${new Date(fact.recordedAt).toLocaleString("zh-CN")}`}
                </Typography.Text>
              </Flex>
            </Card>
          ))}
        </Flex>
      )}
    </Flex>
  );
}
