import React, { useState } from "react";
import { View } from "react-native";
import { Chip, Divider, Icon, Surface, Text, useTheme } from "react-native-paper";
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
} from "../api/rag";
import { pickDocuments } from "../lib/files";
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

export function RagScreen() {
  const theme = useTheme();
  const docs = useAsync(listDocuments);
  const analytics = useAsync(() => getAnalyticsOverview(14));
  const quality = useAsync(() => getQualityReport(30));
  const [query, setQuery] = useState("");
  const [topK, setTopK] = useState("5");
  const [answer, setAnswer] = useState("");
  const [chunks, setChunks] = useState<
    Array<{ source: string; chunkIndex: number; content: string; score: number }>
  >([]);
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
    <WorkspaceScreen title="知识库" description="检索、审核并持续改进团队可复用的知识资产。">
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
          <Btn
            title={busy === "query" ? "检索中…" : "检索"}
            disabled={busy !== null || !query.trim()}
            onPress={() => {
              run("query", async () => {
                const r = await queryKnowledge({ query, topK: Number(topK) || 5, generate: true });
                setAnswer(r.answer ?? "(无生成答案)");
                setChunks(r.chunks);
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
          {chunks.map((c, i) => (
            <View key={`${c.source}-${c.chunkIndex}-${i}`} style={{ marginTop: 10 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Icon source="file-document-outline" size={15} color={theme.colors.primary} />
                <Text variant="labelMedium" style={{ flex: 1 }} numberOfLines={1}>
                  {`${c.source} #${c.chunkIndex}`}
                </Text>
                <Chip compact>{c.score.toFixed(3)}</Chip>
              </View>
              <Text
                variant="bodySmall"
                numberOfLines={2}
                style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}
              >
                {c.content}
              </Text>
            </View>
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
    </WorkspaceScreen>
  );
}
