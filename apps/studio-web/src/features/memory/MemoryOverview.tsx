import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, Flex, Progress, Statistic, Tag, Timeline, Typography } from "antd";
import { ReloadOutlined } from "../../lib/icons.js";
import {
  MEMORY_KIND_LABEL,
  MEMORY_SCOPE_LABEL,
  MEMORY_STATUS_LABEL,
  fetchMemoryStats,
  type MemoryFact,
  type MemoryKind,
  type MemoryScopeKind,
  type MemoryStats,
} from "./api.js";

/** 待审核积压超过该值时提示，不自动处理。 */
const REVIEW_BACKLOG_WARN = 50;
/** 单个 scope 活跃事实过多时提示。 */
const SCOPE_LOAD_WARN = 200;

/** 总览：四个计数卡 + 两个分布 + 近期变更流。 */
export function MemoryOverview({ onOpenFact }: { onOpenFact: (id: string) => void }) {
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [recent, setRecent] = useState<MemoryFact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await fetchMemoryStats();
      setStats(data.stats);
      setRecent(data.recent);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, revision]);

  const kindEntries = Object.entries(stats?.byKind ?? {}) as Array<[MemoryKind, number]>;
  const scopeEntries = Object.entries(stats?.byScope ?? {}) as Array<[MemoryScopeKind, number]>;
  const kindMax = Math.max(1, ...kindEntries.map(([, count]) => count));
  const scopeTotal = scopeEntries.reduce((sum, [, count]) => sum + count, 0);
  const backlog = stats?.unreviewed ?? 0;
  const busiestScope = Math.max(0, ...scopeEntries.map(([, count]) => count));

  return (
    <Flex vertical gap={12}>
      <Flex justify="flex-end">
        <Button icon={<ReloadOutlined />} onClick={() => setRevision((value) => value + 1)}>
          刷新
        </Button>
      </Flex>

      {error ? (
        <Alert
          type="error"
          showIcon
          role="alert"
          message={`总览加载失败：${error}`}
          action={
            <Button size="small" onClick={() => setRevision((value) => value + 1)}>
              重试
            </Button>
          }
        />
      ) : null}

      <Flex gap={12} wrap>
        <Card size="small" loading={loading} className="memory-stat">
          <Statistic title="生效中" value={stats?.active ?? 0} />
        </Card>
        <Card size="small" loading={loading} className="memory-stat">
          <Statistic
            title="待审核"
            value={backlog}
            valueStyle={backlog > 0 ? { color: "#d48806" } : undefined}
          />
        </Card>
        <Card size="small" loading={loading} className="memory-stat">
          <Statistic title="已失效" value={stats?.superseded ?? 0} />
        </Card>
        <Card size="small" loading={loading} className="memory-stat">
          <Statistic title="覆盖个人" value={stats?.persons ?? 0} />
        </Card>
        <Card size="small" loading={loading} className="memory-stat">
          <Statistic title="覆盖群组" value={stats?.groups ?? 0} />
        </Card>
      </Flex>

      {backlog > REVIEW_BACKLOG_WARN || busiestScope > SCOPE_LOAD_WARN ? (
        <Alert
          type="warning"
          showIcon
          message="记忆健康提示"
          description={
            backlog > REVIEW_BACKLOG_WARN
              ? `待审核积压 ${backlog} 条，建议尽快处理以免影响召回质量。`
              : `存在承载 ${busiestScope} 条活跃事实的作用域，建议合并或清理。`
          }
        />
      ) : null}

      <Flex gap={12} wrap align="stretch">
        <Card size="small" title="按类型" className="memory-dist" loading={loading}>
          {kindEntries.length === 0 ? (
            <Typography.Text type="secondary">暂无生效记忆</Typography.Text>
          ) : (
            <Flex vertical gap={8}>
              {kindEntries.map(([kind, count]) => (
                <div key={kind}>
                  <Flex justify="space-between">
                    <Typography.Text>{MEMORY_KIND_LABEL[kind]}</Typography.Text>
                    <Typography.Text type="secondary">{count}</Typography.Text>
                  </Flex>
                  <Progress
                    percent={Math.round((count / kindMax) * 100)}
                    showInfo={false}
                    size="small"
                    aria-label={`${MEMORY_KIND_LABEL[kind]} ${count} 条`}
                  />
                </div>
              ))}
            </Flex>
          )}
        </Card>

        <Card size="small" title="按作用域" className="memory-dist" loading={loading}>
          {scopeEntries.length === 0 ? (
            <Typography.Text type="secondary">暂无生效记忆</Typography.Text>
          ) : (
            <Flex vertical gap={8}>
              {scopeEntries.map(([scope, count]) => (
                <div key={scope}>
                  <Flex justify="space-between">
                    <Typography.Text>{MEMORY_SCOPE_LABEL[scope]}</Typography.Text>
                    <Typography.Text type="secondary">
                      {count}
                      {scopeTotal > 0 ? ` · ${Math.round((count / scopeTotal) * 100)}%` : ""}
                    </Typography.Text>
                  </Flex>
                  <Progress
                    percent={scopeTotal > 0 ? Math.round((count / scopeTotal) * 100) : 0}
                    showInfo={false}
                    size="small"
                    aria-label={`${MEMORY_SCOPE_LABEL[scope]} ${count} 条`}
                  />
                </div>
              ))}
            </Flex>
          )}
        </Card>
      </Flex>

      <Card size="small" title="近期变更" loading={loading}>
        {recent.length === 0 ? (
          <Typography.Text type="secondary">
            还没有记忆。在对话里说“记住……”即可产生第一条。
          </Typography.Text>
        ) : (
          <Timeline
            items={recent.map((fact) => ({
              color:
                fact.status === "active" ? (fact.unreviewed ? "orange" : "green") : "gray",
              children: (
                <Flex vertical gap={2}>
                  <Flex gap={6} wrap align="center">
                    <Typography.Text strong>{fact.slug}</Typography.Text>
                    <Tag>{MEMORY_KIND_LABEL[fact.kind]}</Tag>
                    <Tag color={fact.status === "active" ? "green" : "default"}>
                      {MEMORY_STATUS_LABEL[fact.status]}
                    </Tag>
                    {fact.unreviewed ? <Tag color="gold">待审核</Tag> : null}
                    <Button type="link" size="small" onClick={() => onOpenFact(fact.id)}>
                      查看
                    </Button>
                  </Flex>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {fact.body.slice(0, 120)}
                    {fact.body.length > 120 ? "…" : ""}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    {new Date(fact.updatedAt).toLocaleString("zh-CN")}
                  </Typography.Text>
                </Flex>
              ),
            }))}
          />
        )}
      </Card>
    </Flex>
  );
}
