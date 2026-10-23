import { useState } from "react";
import {
  Alert,
  Button,
  Card,
  Collapse,
  Descriptions,
  Drawer,
  Empty,
  Flex,
  List,
  Progress,
  Segmented,
  Spin,
  Statistic,
  Steps,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { formatShortDateTime as formatDateTime } from "../../lib/format.js";
import {
  getQueryDetail,
  type AnalyticsOverview,
  type QueryDetail,
  type QualityReport,
} from "./api.js";
import { channelLabel } from "./channelLabel.js";

export function RagAnalyticsDashboard({
  overview,
  report,
  loading,
  days,
  onDaysChange,
}: {
  overview: AnalyticsOverview | null;
  report: QualityReport | null;
  loading: boolean;
  days: 7 | 30;
  onDaysChange: (days: 7 | 30) => void;
}) {
  if (loading && !overview)
    return (
      <Flex justify="center" style={{ padding: 48 }}>
        <Spin aria-label="正在汇总查询数据" />
      </Flex>
    );
  if (!overview) return <Empty description="暂无运营数据" />;
  const maxQueries = Math.max(1, ...(report?.trend.map((day) => day.queries) ?? []));
  const helpful = overview.totals.helpfulRate;
  const quality = report?.totals;
  const attribution = report?.attribution;
  const hasNoAnswerHistory = Boolean(attribution?.unknown);
  const [auditQueryId, setAuditQueryId] = useState<string | null>(null);
  const [auditDetail, setAuditDetail] = useState<QueryDetail | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const openAudit = async (queryId: string) => {
    setAuditQueryId(queryId);
    setAuditDetail(null);
    setAuditError(null);
    setAuditLoading(true);
    try {
      const res = await getQueryDetail(queryId);
      setAuditDetail(res.detail);
    } catch (reason) {
      setAuditError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAuditLoading(false);
    }
  };
  const recentColumns: ColumnsType<AnalyticsOverview["recent"][number]> = [
    {
      title: "问题",
      dataIndex: "query",
      key: "query",
      ellipsis: true,
      render: (value: string, record) => (
        <Typography.Text ellipsis title={record.error ?? value} style={{ maxWidth: 240 }}>
          {value}
        </Typography.Text>
      ),
    },
    {
      title: "命中",
      dataIndex: "hitCount",
      key: "hitCount",
      width: 70,
      render: (_: unknown, record) => (record.error ? "失败" : record.hitCount),
    },
    {
      title: "延迟",
      dataIndex: "latencyMs",
      key: "latencyMs",
      width: 90,
      render: (value: number) => `${value} ms`,
    },
    {
      title: "反馈",
      dataIndex: "feedback",
      key: "feedback",
      width: 70,
      render: (value: string | null) =>
        value === "positive" ? "有用" : value === "negative" ? "无用" : "--",
    },
    {
      title: "归因",
      dataIndex: "attribution",
      key: "attribution",
      width: 100,
      render: (value: AnalyticsOverview["recent"][number]["attribution"]) => (
        <Tag>{attributionLabel(value)}</Tag>
      ),
    },
    {
      title: "时间",
      dataIndex: "createdAt",
      key: "createdAt",
      width: 110,
      render: (value: string) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {formatDateTime(value)}
        </Typography.Text>
      ),
    },
    {
      title: "链路",
      key: "trace",
      width: 90,
      render: (_: unknown, record) => (
        <Button type="link" size="small" onClick={() => void openAudit(record.id)}>
          查看链路
        </Button>
      ),
    },
  ];
  return (
    <Flex vertical gap={12}>
      <Flex align="flex-start" justify="space-between" gap={12} wrap>
        <Flex vertical gap={2}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            最近 {days} 天
          </Typography.Text>
          <Typography.Title level={5} style={{ margin: 0 }}>
            知识库服务质量
          </Typography.Title>
        </Flex>
        <Flex gap={8} align="center">
          <Segmented<7 | 30>
            aria-label="报告周期"
            value={days}
            onChange={(value) => onDaysChange(value)}
            options={[
              { value: 7, label: "7 天" },
              { value: 30, label: "30 天" },
            ]}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {loading ? "更新中" : "实时汇总"}
          </Typography.Text>
        </Flex>
      </Flex>

      <Flex gap={12} wrap>
        <Card size="small" style={{ flex: "1 1 160px" }}>
          <Statistic
            title="查询总量"
            value={overview.totals.queries}
            suffix={`失败 ${overview.totals.failed}`}
          />
        </Card>
        <Card
          size="small"
          style={{
            flex: "1 1 160px",
            borderColor: quality && quality.hitRate < 0.75 ? "#d98a2b" : undefined,
          }}
        >
          <Statistic
            title="检索命中率"
            value={quality ? Math.round(quality.hitRate * 100) : "--"}
            suffix={quality ? "%" : ""}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {quality ? `${quality.hits} 次命中文档` : "正在汇总归因"}
          </Typography.Text>
        </Card>
        <Card
          size="small"
          style={{
            flex: "1 1 160px",
            borderColor: quality && quality.noAnswerRate > 0.25 ? "#d98a2b" : undefined,
          }}
        >
          <Statistic
            title="无答案率"
            value={quality ? Math.round(quality.noAnswerRate * 100) : "--"}
            suffix={quality ? "%" : ""}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {quality ? `${quality.noAnswer} 次无答案` : "正在汇总归因"}
          </Typography.Text>
        </Card>
        <Card size="small" style={{ flex: "1 1 160px" }}>
          <Statistic title="平均延迟" value={overview.totals.averageLatencyMs} suffix="ms" />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            含检索与生成
          </Typography.Text>
        </Card>
        <Card
          size="small"
          style={{
            flex: "1 1 160px",
            borderColor: overview.totals.noHitRate > 0.25 ? "#d98a2b" : undefined,
          }}
        >
          <Statistic title="空召回" value={overview.totals.noHits} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {Math.round(overview.totals.noHitRate * 100)}% 的成功请求
          </Typography.Text>
        </Card>
        <Card size="small" style={{ flex: "1 1 160px" }}>
          <Statistic
            title="用户好评"
            value={helpful === null ? "--" : Math.round(helpful * 100)}
            suffix={helpful === null ? "" : "%"}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {overview.totals.positiveFeedback + overview.totals.negativeFeedback} 条反馈
          </Typography.Text>
        </Card>
      </Flex>

      <Flex gap={12} align="flex-start" wrap>
        <Card
          size="small"
          title="无答案归因"
          extra={
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              按实际检索与生成结果
            </Typography.Text>
          }
          style={{ flex: "1 1 320px" }}
        >
          {attribution ? (
            <List
              size="small"
              dataSource={
                [
                  ["no_documents", "没有可见文档", "确认是否已上传文档或分组权限是否匹配"],
                  ["retrieval_miss", "未检索到内容", "补充同义词、标题与问题表述"],
                  ["low_relevance", "内容相关性不足", "补充直接回答该问题的段落"],
                  ["model_refusal", "模型判定无法回答", "检查上下文是否覆盖答案"],
                  ["error", "服务错误", "检查模型、检索服务与网关日志"],
                  ["unknown", "历史未归因", "升级前事件缺少 CRAG 判定"],
                ] as const
              }
              rowKey="0"
              renderItem={([key, label, hint]) => {
                const count = attribution[key];
                const total = Math.max(1, quality?.queries ?? 0);
                return (
                  <List.Item>
                    <Flex vertical gap={4} style={{ width: "100%" }}>
                      <Flex justify="space-between" align="center">
                        <Flex vertical gap={0}>
                          <Typography.Text strong>{label}</Typography.Text>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {hint}
                          </Typography.Text>
                        </Flex>
                        <Typography.Text strong>{count}</Typography.Text>
                      </Flex>
                      <Progress
                        percent={Math.round((count / total) * 100)}
                        showInfo={false}
                        size="small"
                      />
                    </Flex>
                  </List.Item>
                );
              }}
            />
          ) : (
            <Empty description="暂无归因数据" />
          )}
          {hasNoAnswerHistory ? (
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
              历史事件来源版本较旧，无法可靠补判 attribution，因此保留为“历史未归因”。
            </Typography.Paragraph>
          ) : null}
        </Card>

        <Card
          size="small"
          title="Top 未覆盖问题"
          extra={
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              按出现次数
            </Typography.Text>
          }
          style={{ flex: "1 1 280px" }}
        >
          {!report || report.topUnanswered.length === 0 ? (
            <Empty description="暂无未覆盖问题" />
          ) : (
            <List
              size="small"
              dataSource={report.topUnanswered}
              rowKey={(item) => `${item.query}:${item.attribution}`}
              renderItem={(item) => (
                <List.Item>
                  <List.Item.Meta
                    title={
                      <Typography.Text ellipsis title={item.query}>
                        {item.query}
                      </Typography.Text>
                    }
                    description={attributionLabel(item.attribution)}
                  />
                  <Tag>{String(item.count).padStart(2, "0")}</Tag>
                </List.Item>
              )}
            />
          )}
        </Card>
      </Flex>

      <Flex gap={12} align="flex-start" wrap>
        <Card
          size="small"
          title="质量趋势"
          extra={
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              柱高为每日查询量，橙色为无答案
            </Typography.Text>
          }
          style={{ flex: "2 1 420px" }}
        >
          <Flex gap={4} align="flex-end" style={{ minHeight: 120 }}>
            {(report?.trend ?? []).map((day) => (
              <Tooltip
                key={day.date}
                title={`${day.date}: ${day.queries} 次查询，${day.noAnswer} 次无答案`}
              >
                <Flex vertical align="center" gap={4} style={{ flex: 1, minWidth: 0 }}>
                  <Typography.Text style={{ fontSize: 11 }}>{day.queries || ""}</Typography.Text>
                  <div
                    style={{
                      width: "100%",
                      height: Math.max(day.queries > 0 ? 8 : 2, (day.queries / maxQueries) * 100),
                      background: "#f0efea",
                      borderRadius: 4,
                      position: "relative",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        position: "absolute",
                        bottom: 0,
                        width: "100%",
                        height: `${day.queries > 0 ? (day.noAnswer / day.queries) * 100 : 0}%`,
                        background: "#d9822b",
                      }}
                    />
                  </div>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    {days === 7 ? day.date.slice(5) : day.date.slice(5)}
                  </Typography.Text>
                </Flex>
              </Tooltip>
            ))}
          </Flex>
        </Card>

        <Card
          size="small"
          title="热门知识来源"
          extra={
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              按召回片段数
            </Typography.Text>
          }
          style={{ flex: "1 1 240px" }}
        >
          {overview.topSources.length === 0 ? (
            <Empty description="暂无命中来源" />
          ) : (
            <List
              size="small"
              dataSource={overview.topSources}
              rowKey="source"
              renderItem={(source, index) => (
                <List.Item>
                  <Tag>{String(index + 1).padStart(2, "0")}</Tag>
                  <Typography.Text ellipsis title={source.source} style={{ flex: 1 }}>
                    {source.source}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {source.hits} hits
                  </Typography.Text>
                </List.Item>
              )}
            />
          )}
        </Card>
      </Flex>

      <Card
        size="small"
        title="最近查询"
        extra={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            最多展示 20 条
          </Typography.Text>
        }
        styles={{ body: { padding: 0 } }}
      >
        <Table
          size="small"
          rowKey="id"
          columns={recentColumns}
          dataSource={overview.recent}
          pagination={false}
          scroll={{ x: "max-content" }}
          locale={{ emptyText: <Empty description="运行检索后会在这里显示质量数据" /> }}
        />
      </Card>
      <Drawer
        title="检索链路审计"
        open={auditQueryId !== null}
        onClose={() => {
          setAuditQueryId(null);
          setAuditDetail(null);
          setAuditError(null);
        }}
        width={720}
      >
        {auditLoading ? (
          <Flex justify="center" style={{ padding: 48 }}>
            <Spin aria-label="正在加载链路详情" />
          </Flex>
        ) : auditError ? (
          <Alert type="error" showIcon message={auditError} />
        ) : !auditDetail ? (
          <Empty description="选择一条查询查看完整链路" />
        ) : (
          <AuditTraceView detail={auditDetail} />
        )}
      </Drawer>
    </Flex>
  );
}

function AuditTraceView({ detail }: { detail: QueryDetail }) {
  const trace = detail.trace;
  const fusedColumns: ColumnsType<NonNullable<QueryDetail["trace"]>["fused"][number]> = [
    {
      title: "#",
      key: "rank",
      width: 50,
      render: (_: unknown, _record, index: number) => `#${String(index + 1).padStart(2, "0")}`,
    },
    {
      title: "来源",
      dataIndex: "source",
      key: "source",
      width: 140,
      ellipsis: true,
      render: (value: string, record) => (
        <Typography.Text
          ellipsis
          title={`${value} · 第${record.chunkIndex + 1}段`}
          style={{ fontSize: 12 }}
        >
          {value} · {record.chunkIndex + 1}
        </Typography.Text>
      ),
    },
    {
      title: "通道",
      key: "channels",
      width: 110,
      render: (_: unknown, record) => {
        // 审计回放与检索预览共用同一套三路标签，避免旧「channels.length === 2」判定把图谱路算错。
        const tag = channelLabel(record.channels);
        return <Tag color={tag.color}>{tag.label}</Tag>;
      },
    },
    {
      title: "RRF",
      dataIndex: "rrfScore",
      key: "rrfScore",
      width: 90,
      render: (value: number) => (
        <Typography.Text style={{ fontSize: 12 }}>{value.toFixed(4)}</Typography.Text>
      ),
    },
    {
      title: "向量分",
      dataIndex: "vectorScore",
      key: "vectorScore",
      width: 110,
      render: (value: number | null, record) =>
        value === null ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            —
          </Typography.Text>
        ) : (
          <Typography.Text style={{ fontSize: 12 }}>
            {value.toFixed(4)} #{(record.vectorRank ?? 0) + 1}
          </Typography.Text>
        ),
    },
    {
      title: "关键词分",
      dataIndex: "keywordScore",
      key: "keywordScore",
      width: 110,
      render: (value: number | null, record) =>
        value === null ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            —
          </Typography.Text>
        ) : (
          <Typography.Text style={{ fontSize: 12 }}>
            {value.toFixed(4)} #{(record.keywordRank ?? 0) + 1}
          </Typography.Text>
        ),
    },
    {
      title: "图谱分",
      dataIndex: "graphScore",
      key: "graphScore",
      width: 110,
      render: (value: number | null | undefined, record) =>
        value === null || value === undefined ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            —
          </Typography.Text>
        ) : (
          <Typography.Text style={{ fontSize: 12 }}>
            {value.toFixed(4)} #{(record.graphRank ?? 0) + 1}
          </Typography.Text>
        ),
    },
  ];
  const channelColumns: ColumnsType<{
    id: string;
    source: string;
    chunkIndex: number;
    score: number;
    rank: number;
  }> = [
    {
      title: "排名",
      dataIndex: "rank",
      key: "rank",
      width: 70,
      render: (value: number) => `#${value + 1}`,
    },
    {
      title: "来源",
      dataIndex: "source",
      key: "source",
      ellipsis: true,
      render: (value: string, record) => (
        <Typography.Text ellipsis title={value} style={{ fontSize: 12 }}>
          {value} · {record.chunkIndex + 1}
        </Typography.Text>
      ),
    },
    {
      title: "原始分",
      dataIndex: "score",
      key: "score",
      width: 100,
      render: (value: number) => (
        <Typography.Text style={{ fontSize: 12 }}>{value.toFixed(4)}</Typography.Text>
      ),
    },
  ];
  return (
    <Flex vertical gap={12}>
      <Flex gap={8} align="center" wrap>
        <Typography.Title level={5} style={{ margin: 0, flex: 1 }}>
          {detail.query}
        </Typography.Title>
        <Typography.Text
          copyable={{ text: detail.id }}
          type="secondary"
          style={{ fontSize: 12 }}
          title={detail.id}
        >
          {detail.id.slice(0, 8)}
        </Typography.Text>
      </Flex>
      <Descriptions size="small" column={2} bordered>
        <Descriptions.Item label="归因">{attributionLabel(detail.attribution)}</Descriptions.Item>
        <Descriptions.Item label="延迟">{`${detail.latencyMs} ms`}</Descriptions.Item>
        <Descriptions.Item label="Top-K">{detail.topK}</Descriptions.Item>
        <Descriptions.Item label="命中">{detail.hitCount}</Descriptions.Item>
        <Descriptions.Item label="时间">{formatDateTime(detail.createdAt)}</Descriptions.Item>
        <Descriptions.Item label="反馈">
          {detail.feedback === "positive" ? "有用" : detail.feedback === "negative" ? "无用" : "--"}
        </Descriptions.Item>
      </Descriptions>
      {detail.error ? <Alert type="error" showIcon message={detail.error} /> : null}
      {!trace ? (
        <Alert
          type="warning"
          showIcon
          message="历史事件无链路明细（升级前写入），仅可看聚合指标。新的检索会自动写入完整链路。"
        />
      ) : (
        <>
          <Steps
            direction="vertical"
            size="small"
            items={[
              {
                key: "acl",
                status: "finish",
                title: `ACL 解析 · 可见 ${trace.visibleSources?.length ?? detail.sourceCount} 个来源`,
                description: (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    请求 sources: {(detail.sources ?? []).join("、") || "全库"} · 可见:{" "}
                    {(trace.visibleSources ?? []).join("、") || "全库"} · 分组:{" "}
                    {(trace.viewerGroups ?? []).join("、") || "管理侧全量"}
                  </Typography.Text>
                ),
              },
              {
                key: "vector",
                status: trace.embeddingsEnabled ? "finish" : "wait",
                title: `向量检索 · ${trace.vectorHits.length} 候选${trace.timingsMs.vectorMs === null ? "（未启用）" : ""}`,
                description: trace.embeddingsEnabled ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    余弦相似度排序，耗时 {trace.timingsMs.vectorMs ?? 0} ms，候选窗口{" "}
                    {trace.candidates}
                  </Typography.Text>
                ) : (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    未配置 Embeddings，本次退化为纯关键词检索
                  </Typography.Text>
                ),
              },
              {
                key: "keyword",
                status: trace.keywordEnabled === false ? "wait" : "finish",
                title:
                  trace.keywordEnabled === false
                    ? "关键词检索 · 未启用"
                    : `关键词检索 · ${trace.keywordHits.length} 候选`,
                description: (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {trace.keywordEnabled === false
                      ? "仅向量召回模式：本次请求关闭了 BM25 关键词通道"
                      : `BM25 先 AND 后 OR 降级，耗时 ${trace.timingsMs.keywordMs} ms`}
                  </Typography.Text>
                ),
              },
              {
                key: "graph",
                status: trace.graphEnabled === false ? "wait" : "finish",
                title:
                  trace.graphEnabled === false
                    ? "图谱检索 · 未启用"
                    : `图谱检索 · ${trace.graphHits?.length ?? 0} 候选`,
                description: (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {trace.graphEnabled === false
                      ? trace.keywordEnabled === false
                        ? "本次请求关闭图谱检索，仅使用向量召回"
                        : "本次请求关闭图谱检索，仅融合向量与关键词"
                      : `子图回溯真实分块后参与 RRF，耗时 ${trace.timingsMs.graphMs ?? 0} ms`}
                  </Typography.Text>
                ),
              },
              {
                key: "rrf",
                status: "finish",
                title: `RRF 融合 · k=${trace.rrfK} · 取 Top-${detail.topK}`,
                description: (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    只看排名不看原始分，融合耗时 {trace.timingsMs.fusionMs} ms，存储 {trace.store}
                    {trace.truncated ? "（候选原文已截断，融合块为全量）" : ""}
                  </Typography.Text>
                ),
              },
              {
                key: "llm",
                status: detail.answerGenerated ? "finish" : "wait",
                title: detail.answerGenerated ? "LLM 生成已回答" : "LLM 未生成",
                description: (
                  <Typography.Paragraph style={{ fontSize: 12, marginBottom: 0 }}>
                    {trace.answer ?? detail.answer ?? "无回答（资料不足或 LLM 未启用）"}
                  </Typography.Paragraph>
                ),
              },
            ]}
          />
          <Card size="small" title={`融合结果 Top-${detail.topK}（最终排序依据 RRF）`}>
            <Table
              size="small"
              rowKey="id"
              columns={fusedColumns}
              dataSource={trace.fused}
              pagination={false}
              scroll={{ x: "max-content" }}
            />
          </Card>
          <Collapse
            size="small"
            items={[
              {
                key: "vector",
                label: `向量候选（${trace.vectorHits.length}）· 余弦分同路可比`,
                children: (
                  <Table
                    size="small"
                    rowKey="id"
                    columns={channelColumns}
                    dataSource={trace.vectorHits.slice(0, 30)}
                    pagination={false}
                    scroll={{ x: "max-content" }}
                  />
                ),
              },
              {
                key: "keyword",
                label: `关键词候选（${trace.keywordHits.length}）· BM25 分同路可比`,
                children: (
                  <Table
                    size="small"
                    rowKey="id"
                    columns={channelColumns}
                    dataSource={trace.keywordHits.slice(0, 30)}
                    pagination={false}
                    scroll={{ x: "max-content" }}
                  />
                ),
              },
              ...(trace.graphEnabled === false
                ? []
                : [
                    {
                      key: "graph",
                      label: `图谱候选（${trace.graphHits?.length ?? 0}）· 子图关系权重`,
                      children: (
                        <Table
                          size="small"
                          rowKey="id"
                          columns={channelColumns}
                          dataSource={(trace.graphHits ?? []).slice(0, 30)}
                          pagination={false}
                          scroll={{ x: "max-content" }}
                        />
                      ),
                    } as const,
                  ]),
              ...(trace.formatted
                ? [
                    {
                      key: "context",
                      label: "拼入 LLM 的上下文（formatted）",
                      children: (
                        <Typography.Paragraph code style={{ fontSize: 12 }}>
                          {trace.formatted}
                        </Typography.Paragraph>
                      ),
                    } as const,
                  ]
                : []),
              ...(trace.graphContext
                ? [
                    {
                      key: "graph-context",
                      label: "知识图谱上下文（参与提示词增强）",
                      children: (
                        <Typography.Paragraph code style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>
                          {trace.graphContext}
                        </Typography.Paragraph>
                      ),
                    } as const,
                  ]
                : []),
            ]}
          />
        </>
      )}
    </Flex>
  );
}

function attributionLabel(attribution: AnalyticsOverview["recent"][number]["attribution"]): string {
  switch (attribution) {
    case "no_documents":
      return "没有文档";
    case "retrieval_miss":
      return "未检索到";
    case "low_relevance":
      return "相关不足";
    case "model_refusal":
      return "模型拒答";
    case "error":
      return "服务错误";
    case "answered":
      return "已回答";
    default:
      return "历史未归因";
  }
}
