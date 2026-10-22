import React, { useState } from "react";
import { View } from "react-native";
import { Chip, Divider, Icon, Surface, Switch, Text, useTheme } from "react-native-paper";
import {
  deleteDocument,
  getAnalyticsOverview,
  getQualityReport,
  listChunks,
  listDocuments,
  queryKnowledge,
  submitQueryFeedback,
  updateDocument,
  uploadDocuments,
  type GraphQueryAugmentation,
  type QueryChunkHit,
} from "../api/rag";
import {
  listEntities,
  neighborsOf,
  reconcileGraph,
  relationTypes,
  retrieveGraph,
  syncStatus,
} from "../api/graph";
import { pickDocuments } from "../lib/files";
import { channelLabels } from "../lib/channelLabel";
import { useAsync } from "../hooks/useAsync";
import {
  Btn,
  Card,
  ErrorText,
  Field,
  Loading,
  Sub,
} from "../components/ui";
import { WorkspaceScreen } from "../components/workspaceScreen";

/** graph.context 摘要长度上限，避免长文本撑爆移动端列表。 */
const GRAPH_CONTEXT_PREVIEW = 300;

export function RagScreen() {
  const theme = useTheme();
  const docs = useAsync(listDocuments);
  const analytics = useAsync(() => getAnalyticsOverview(14));
  const quality = useAsync(() => getQualityReport(30));
  const [query, setQuery] = useState("");
  const [topK, setTopK] = useState("5");
  const [graphEnabled, setGraphEnabled] = useState(true);
  const [answer, setAnswer] = useState("");
  const [chunks, setChunks] = useState<QueryChunkHit[]>([]);
  const [graph, setGraph] = useState<GraphQueryAugmentation | null>(null);
  const [queryId, setQueryId] = useState("");
  const [chunkPreview, setChunkPreview] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState("");
  const [chunkSize, setChunkSize] = useState("1024");
  const [chunkOverlap, setChunkOverlap] = useState("50");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = (key: string, task: () => Promise<void>) => {
    setBusy(key);
    setActionError(null);
    void task()
      .catch((error: unknown) =>
        setActionError(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setBusy(null));
  };

  return (
    <WorkspaceScreen
      title="知识库"
      description="文档检索、图谱增强与质量运营：检索时同步使用实体关系多路补充召回。"
    >
      <ErrorText message={actionError} />
        <Card>
          <Sub>检索问答</Sub>
          <Field
            label="问题"
            value={query}
            onChange={setQuery}
            multiline
            placeholder="输入知识库问题"
          />
          <Field label="topK" value={topK} onChange={setTopK} placeholder="5" />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 }}>
            <View style={{ flex: 1 }}>
              <Text variant="titleSmall">图谱增强</Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                用实体关系多路补充召回，命中分块参与 RRF 融合
              </Text>
            </View>
            <Switch value={graphEnabled} onValueChange={setGraphEnabled} />
          </View>
          {graphEnabled ? null : (
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              已关闭图谱增强：本次检索仅使用向量与关键词两路。
            </Text>
          )}
          <Btn
            title={busy === "query" ? "检索中…" : "检索"}
            disabled={busy !== null || !query.trim()}
            onPress={() => {
              run("query", async () => {
                const r = await queryKnowledge({
                  query,
                  topK: Number(topK) || 5,
                  generate: true,
                  // 关闭时显式传 false，让后端跳过图谱通道。
                  ...(graphEnabled ? {} : { graph: false }),
                });
                setAnswer(r.answer ?? "(无生成答案)");
                setChunks(r.chunks ?? []);
                setGraph(r.graph ?? null);
                setQueryId(r.queryId);
              });
            }}
          />
          {answer ? (
            <Surface
              elevation={0}
              style={{
                marginTop: 14,
                padding: 14,
                borderRadius: 14,
                backgroundColor: theme.colors.surfaceVariant,
              }}
            >
              <Text variant="bodyMedium" style={{ lineHeight: 22 }}>
                {answer}
              </Text>
            </Surface>
          ) : null}
          <GraphAugmentationCard graph={graph} />
          {chunks.map((chunk, index) => (
            <ChunkHitRow key={`${chunk.source}-${chunk.chunkIndex}-${index}`} chunk={chunk} />
          ))}
          {queryId ? (
            <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
              <Btn
                title="有帮助"
                kind="ghost"
                onPress={() => {
                  run("feedback-up", async () => {
                    await submitQueryFeedback(queryId, "positive");
                    setQueryId("");
                    setAnswer(`${answer}\n\n已记录正向反馈。`);
                  });
                }}
              />
              <Btn
                title="需改进"
                kind="ghost"
                onPress={() => {
                  run("feedback-down", async () => {
                    await submitQueryFeedback(queryId, "negative");
                    setQueryId("");
                    setAnswer(`${answer}\n\n已记录改进反馈。`);
                  });
                }}
              />
            </View>
          ) : null}
        </Card>
        <Card>
          <Sub>文档</Sub>
          {docs.loading ? <Loading /> : null}
          <ErrorText message={docs.error} onRetry={docs.reload} />
          <Text>{`共 ${(docs.data?.sources ?? []).length} 个来源 · ${docs.data?.chunks ?? 0} 分块`}</Text>
          {(docs.data?.sources ?? []).slice(0, 30).map((d) => (
            <View
              key={d.source}
              style={{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: theme.colors.outlineVariant }}
            >
              <Text
                numberOfLines={1}
              >{`${d.title || d.source} · v${d.version} · ${d.chunks}块 · ${d.chunkStrategy}`}</Text>
              <View style={{ flexDirection: "row", gap: 6, marginTop: 4 }}>
                <Btn
                  title={busy === `chunks-${d.source}` ? "读取中…" : "分块"}
                  kind="ghost"
                  disabled={busy !== null}
                  onPress={() => {
                    run(`chunks-${d.source}`, async () => {
                      const r = await listChunks(d.source);
                      setChunkPreview(
                        r.chunks
                          .slice(0, 3)
                          .map((c) => `#${c.chunkIndex} ${c.content.slice(0, 60)}`)
                          .join("\n") || "(空)",
                      );
                    });
                  }}
                />
                <Btn
                  title="改标题"
                  kind="ghost"
                  disabled={busy !== null}
                  onPress={() => {
                    run(`rename-${d.source}`, async () => {
                      await updateDocument(d.source, { title: `${d.title || d.source} (已核)` });
                      docs.reload();
                    });
                  }}
                />
                <Btn
                  title="删除"
                  kind="danger"
                  disabled={busy !== null}
                  onPress={() => {
                    run(`delete-${d.source}`, async () => {
                      await deleteDocument(d.source);
                      docs.reload();
                    });
                  }}
                />
              </View>
            </View>
          ))}
          {chunkPreview ? (
            <Surface
              elevation={0}
              style={{
                marginTop: 12,
                padding: 12,
                borderRadius: 12,
                backgroundColor: theme.colors.surfaceVariant,
              }}
            >
              <Text variant="bodySmall" style={{ lineHeight: 19 }}>
                {chunkPreview}
              </Text>
            </Surface>
          ) : null}
          <Sub>上传文档（与 Web 同切分参数）</Sub>
          <Field label="chunkSize" value={chunkSize} onChange={setChunkSize} placeholder="1024" />
          <Field
            label="chunkOverlap"
            value={chunkOverlap}
            onChange={setChunkOverlap}
            placeholder="50"
          />
          <Divider style={{ marginVertical: 14 }} />
          <Btn
            title={uploading ? "上传中…" : "选择文件并上传"}
            kind="ghost"
            disabled={uploading}
            onPress={() => {
              setUploading(true);
              setUploadMsg("");
              void (async () => {
                try {
                  const picked = await pickDocuments({ multiple: true });
                  if (picked.length === 0) {
                    setUploadMsg("未选择文件");
                    return;
                  }
                  const r = await uploadDocuments(
                    picked.map((f) => ({
                      name: f.name,
                      ...(f.mimeType ? { mimeType: f.mimeType } : {}),
                      data: f.data,
                    })),
                    {
                      chunkSize: Number(chunkSize) || 1024,
                      chunkOverlap: Number(chunkOverlap) || 50,
                      chunkStrategy: "fixed",
                      separators: ["\n\n", "\n", "。", "！", "？", ". ", " "],
                      semanticThreshold: 0.75,
                    },
                  );
                  setUploadMsg(`上传完成：${r.files} 个文件 · ${r.chunks} 分块`);
                  docs.reload();
                } catch (e) {
                  setUploadMsg(e instanceof Error ? e.message : String(e));
                } finally {
                  setUploading(false);
                }
              })();
            }}
          />
          {uploadMsg ? (
            <Text variant="bodySmall" style={{ marginTop: 8, color: theme.colors.onSurfaceVariant }}>
              {uploadMsg}
            </Text>
          ) : null}
        </Card>
        <Card>
          <Sub>运营分析（14天）</Sub>
          {analytics.loading ? <Loading /> : null}
          <ErrorText message={analytics.error} onRetry={analytics.reload} />
          {analytics.data ? (
            <Text>{`查询 ${analytics.data.totals.queries} · 空召回率 ${(analytics.data.totals.noHitRate * 100).toFixed(1)}% · 平均延迟 ${Math.round(analytics.data.totals.averageLatencyMs)}ms`}</Text>
          ) : null}
        </Card>
        <Card>
          <Sub>质量报告（30天）</Sub>
          {quality.loading ? <Loading /> : null}
          <ErrorText message={quality.error} onRetry={quality.reload} />
          {quality.data ? (
            <Text>{`命中率 ${(quality.data.totals.hitRate * 100).toFixed(1)}% · 未答 ${quality.data.totals.noAnswer} 条`}</Text>
          ) : null}
        </Card>
        <GraphToolsCard />
    </WorkspaceScreen>
  );
}

/** 检索命中行：来源 + RRF 分 + 三路通道标签 + 图谱分。 */
function ChunkHitRow({ chunk }: { chunk: QueryChunkHit }) {
  const theme = useTheme();
  const tags = channelLabels(chunk.debug?.channels);
  const graphScore = chunk.debug?.graphScore;
  const graphRank = chunk.debug?.graphRank;
  return (
    <View style={{ marginTop: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon source="file-document-outline" size={15} color={theme.colors.primary} />
        <Text variant="labelMedium" style={{ flex: 1 }} numberOfLines={1}>
          {`${chunk.source} #${chunk.chunkIndex}`}
        </Text>
        <Chip compact>{chunk.score.toFixed(3)}</Chip>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
        {tags.map((tag) => (
          <Chip
            key={tag.channel}
            compact
            mode="outlined"
            style={{ backgroundColor: theme.colors[`${tag.color}Container`] }}
          >
            {tag.label}
          </Chip>
        ))}
        {/* 旧服务端没有 debug 明细时不展示图谱分，避免出现无意义的空标签。 */}
        {chunk.debug ? (
          <Chip compact mode="outlined">
            {`图谱 ${typeof graphScore === "number" ? graphScore.toFixed(3) : "—"}${
              typeof graphRank === "number" ? ` · #${graphRank}` : ""
            }`}
          </Chip>
        ) : null}
      </View>
      <Text
        variant="bodySmall"
        numberOfLines={2}
        style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}
      >
        {chunk.content}
      </Text>
    </View>
  );
}

/** 图谱增强结果卡：种子实体 + 计数 + context 摘要。 */
function GraphAugmentationCard({ graph }: { graph: GraphQueryAugmentation | null }) {
  const theme = useTheme();
  if (!graph) return null;
  // 服务端明确返回「图谱增强未启用」时给出说明，不渲染空卡片。
  if (!graph.enabled) {
    return (
      <Text variant="bodySmall" style={{ marginTop: 10, color: theme.colors.onSurfaceVariant }}>
        图谱增强未启用：已关闭图谱增强，或服务端未开启图谱检索。
      </Text>
    );
  }
  const contextPreview =
    graph.context.length > GRAPH_CONTEXT_PREVIEW
      ? `${graph.context.slice(0, GRAPH_CONTEXT_PREVIEW)}…`
      : graph.context;
  return (
    <Surface
      elevation={0}
      style={{
        marginTop: 14,
        padding: 14,
        borderRadius: 14,
        backgroundColor: theme.colors.surfaceVariant,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon source="graph-outline" size={18} color={theme.colors.secondary} />
        <Text variant="titleSmall" style={{ flex: 1 }}>
          知识图谱增强
        </Text>
        <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
          {`实体 ${graph.entities} · 关系 ${graph.relations} · 分块 ${graph.chunkHits}`}
        </Text>
      </View>
      {graph.seeds.length > 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
          {graph.seeds.slice(0, 8).map((seed) => (
            <Chip key={seed.id} compact mode="outlined">
              {`${seed.name} · ${seed.type}`}
            </Chip>
          ))}
        </View>
      ) : (
        <Text variant="bodySmall" style={{ marginTop: 8, color: theme.colors.onSurfaceVariant }}>
          未识别到种子实体，本次仅使用向量与关键词两路召回。
        </Text>
      )}
      {graph.chunkHits === 0 ? (
        <Text variant="bodySmall" style={{ marginTop: 8, color: theme.colors.onSurfaceVariant }}>
          图谱未回溯到分块，本次结果仅由向量与关键词贡献。
        </Text>
      ) : null}
      {contextPreview ? (
        <Text variant="bodySmall" style={{ marginTop: 10, lineHeight: 19, fontFamily: "monospace" }}>
          {contextPreview}
        </Text>
      ) : null}
    </Surface>
  );
}

/**
 * 知识图谱区块（由原 GraphScreen 合并而来）。
 * 子图检索、实体邻居、关系类型、同步对账纵向排列；内部各请求使用独立 useAsync，
 * 与知识库主检索/上传/质量区互不阻塞。
 */
function GraphToolsCard() {
  return (
    <Card>
      <Sub>知识图谱</Sub>
      <Text variant="bodySmall" style={{ lineHeight: 19 }}>
        沿实体与关系检索上下文，检查图谱与源数据是否一致。包含子图检索、实体邻居、关系类型分布与
        同步对账；图谱同时作为检索的第三路通道参与 RRF 融合。
      </Text>
      <GraphToolsBody />
    </Card>
  );
}

function GraphToolsBody() {
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const [out, setOut] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const entities = useAsync(() => listEntities({ limit: 20 }));
  const relTypes = useAsync(relationTypes);
  const sync = useAsync(syncStatus);

  const run = (key: string, task: () => Promise<void>) => {
    setBusy(key);
    setActionError(null);
    void task()
      .catch((error: unknown) =>
        setActionError(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setBusy(null));
  };

  return (
    <View style={{ marginTop: 12 }}>
      <ErrorText message={actionError} />
      <Sub>子图检索</Sub>
      <Field label="检索" value={query} onChange={setQuery} placeholder="输入实体/关系关键词" />
      <Btn
        title={busy === "retrieve" ? "检索中…" : "子图检索"}
        disabled={busy !== null || !query.trim()}
        onPress={() => {
          run("retrieve", async () => {
            const result = await retrieveGraph(query, 2);
            setOut(`${result.formatted}`.slice(0, 800) || `(种子 ${result.seeds.length})`);
          });
        }}
      />
      {out ? (
        <Surface
          elevation={0}
          style={{
            marginTop: 10,
            padding: 12,
            borderRadius: 12,
            backgroundColor: theme.colors.surfaceVariant,
          }}
        >
          <Text variant="bodySmall" style={{ lineHeight: 20 }}>
            {out}
          </Text>
        </Surface>
      ) : null}

      <Sub>实体（前20）</Sub>
      {entities.loading ? <Loading /> : null}
      <ErrorText message={entities.error} onRetry={entities.reload} />
      {(entities.data?.entities ?? []).slice(0, 20).map((entity) => (
        <View
          key={entity.id}
          style={{
            paddingVertical: 8,
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.outlineVariant,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Icon source="circle-medium" size={17} color={theme.colors.secondary} />
            <Text variant="titleSmall" style={{ flex: 1 }} numberOfLines={1}>
              {entity.name}
            </Text>
            <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {entity.type}
            </Text>
          </View>
          <Btn
            title="展开邻居"
            kind="ghost"
            disabled={busy !== null}
            onPress={() => {
              run(`neighbors-${entity.id}`, async () => {
                const graph = await neighborsOf(entity.id, 2);
                setOut(`邻居：节点 ${graph.nodes.length} · 边 ${graph.edges.length}`);
              });
            }}
          />
        </View>
      ))}

      <Sub>关系类型</Sub>
      {relTypes.loading ? <Loading /> : null}
      <ErrorText message={relTypes.error} onRetry={relTypes.reload} />
      {(relTypes.data?.types ?? []).slice(0, 10).map((item) => (
        <View
          key={item.relType}
          style={{ flexDirection: "row", alignItems: "center", paddingVertical: 6 }}
        >
          <Text variant="bodyMedium" style={{ flex: 1 }}>
            {item.relType}
          </Text>
          <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
            {item.count}
          </Text>
        </View>
      ))}

      <Sub>同步状态</Sub>
      {sync.loading ? <Loading /> : null}
      <ErrorText message={sync.error} onRetry={sync.reload} />
      {sync.data ? (
        <Text>
          {sync.data.inSync
            ? "已同步"
            : `缺失 ${sync.data.missing.length} · 过期 ${sync.data.stale.length} · 孤儿 ${sync.data.orphan.length}`}
        </Text>
      ) : null}
      <Btn
        title={busy === "reconcile" ? "对账中…" : "一键对账"}
        disabled={busy !== null}
        onPress={() => {
          run("reconcile", async () => {
            await reconcileGraph();
            sync.reload();
          });
        }}
      />
    </View>
  );
}
