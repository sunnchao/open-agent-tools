import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  Checkbox,
  Collapse,
  Descriptions,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  List,
  Popconfirm,
  Segmented,
  Slider,
  Spin,
  Statistic,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  BarChartOutlined,
  CloudUploadOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  DislikeOutlined,
  FileTextOutlined,
  LikeOutlined,
  NodeIndexOutlined,
  ReloadOutlined,
  SaveOutlined,
  SearchOutlined,
  SettingOutlined,
  TagOutlined,
} from "../../lib/icons.js";
import { StudioPage } from "../../components/studio/StudioPageHeader.js";
import { StudioNotice, type StudioNoticeValue } from "../../components/studio/StudioNotice.js";
import { parseDelimitedStringList } from "@open-agent-tools/api-contracts/values";
import {
  deleteDocument,
  getAnalyticsOverview,
  getQualityReport,
  listChunks,
  listDocuments,
  queryKnowledge,
  recallOptions,
  submitQueryFeedback,
  updateDocument,
  uploadDocuments,
  type AnalyticsOverview,
  type ChunkInfo,
  type ChunkStrategy,
  type DocumentSource,
  type DocumentStats,
  type GraphQueryAugmentation,
  type QueryFeedbackRating,
  type QueryResult,
  type QualityReport,
} from "./api.js";
import { channelLabel } from "./channelLabel.js";
import { subscribeChunkTarget } from "./chunkTarget.js";
import { GraphPanel } from "./GraphPanel.js";
import { type RagView } from "./ragRoute.js";
import { UsageTag } from "../../components/UsageTag.js";
import { RagAnalyticsDashboard } from "./RagAnalyticsDashboard.js";
import { formatBytes, formatShortDateTime as formatDateTime } from "../../lib/format.js";
import {
  DEFAULT_RAG_SEPARATORS,
  separatorsFromText,
  separatorsToText,
  validateSeparators,
} from "./ragSettings.js";

interface RagSettings {
  chunkSize: number;
  chunkOverlap: number;
  chunkStrategy: ChunkStrategy;
  separators: string[];
  semanticThreshold: number;
  topK: number;
  generate: boolean;
  restrictToSelected: boolean;
  /**
   * 图谱检索（多路召回）开关，默认开启。
   * 开启：向量 + 关键词 + 图谱三路召回；关闭：仅向量召回（图谱与关键词通道同时关闭）。
   */
  graphEnhance: boolean;
}

/** 三路融合口径说明：放在常量里避免长中文串在 JSX 中被随意折行破坏可读性。 */
const RRF_CHANNEL_HINT =
  "RRF 只看排名不看原始分：同一分块在多路排名越靠前，融合分越高。" +
  "向量分为余弦相似度、关键词分为 BM25、图谱分为子图关系权重，三路绝对值不可直接跨路比较。";

const defaultSettings: RagSettings = {
  chunkSize: 1024,
  chunkOverlap: 50,
  chunkStrategy: "fixed",
  separators: DEFAULT_RAG_SEPARATORS,
  semanticThreshold: 0.75,
  topK: 5,
  generate: true,
  restrictToSelected: false,
  graphEnhance: true,
};

export interface RagWorkspaceProps {
  /** 路由传入的初始视图；旧 #/graph 会带 graph。 */
  initialView?: RagView;
  /** 路由传入的初始文档；旧 #/graph/<source> 的首段就是文档名。 */
  initialSource?: string | null;
}

export function RagWorkspace({ initialView, initialSource }: RagWorkspaceProps) {
  const { message } = App.useApp();
  const settingsInitialized = useRef(false);
  const [stats, setStats] = useState<DocumentStats | null>(null);
  const [selectedSource, setSelectedSource] = useState<string | null>(initialSource ?? null);
  const [chunks, setChunks] = useState<ChunkInfo[]>([]);
  const [highlightChunkIndex, setHighlightChunkIndex] = useState<number | null>(null);
  const [settings, setSettings] = useState<RagSettings>(defaultSettings);
  const [separatorText, setSeparatorText] = useState(() =>
    separatorsToText(DEFAULT_RAG_SEPARATORS),
  );
  const queryDraftRef = useRef("");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [view, setView] = useState<RagView>(initialView ?? "documents");
  const [analytics, setAnalytics] = useState<AnalyticsOverview | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [qualityReport, setQualityReport] = useState<QualityReport | null>(null);
  const [qualityDays, setQualityDays] = useState<7 | 30>(7);
  const [feedback, setFeedback] = useState<Record<string, QueryFeedbackRating>>({});
  const [busy, setBusy] = useState<"loading" | "upload" | "query" | null>("loading");
  const [notice, setNotice] = useState<StudioNoticeValue | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await listDocuments();
      setStats(next);
      if (!settingsInitialized.current) {
        setSettings((current) => ({
          ...current,
          chunkSize: next.chunkSize ?? current.chunkSize,
          chunkOverlap: next.chunkOverlap ?? current.chunkOverlap,
          chunkStrategy: next.chunkStrategy ?? current.chunkStrategy,
          separators: next.separators ?? current.separators,
          semanticThreshold: next.semanticThreshold ?? current.semanticThreshold,
        }));
        if (next.separators) setSeparatorText(separatorsToText(next.separators));
        settingsInitialized.current = true;
      }
      // 路由指定的文档可能已被删除：回落到第一个来源，避免后续请求 404。
      setSelectedSource((current) =>
        current && next.sources.some((document) => document.source === current)
          ? current
          : (next.sources[0]?.source ?? null),
      );
    } catch (reason) {
      setNotice({ type: "error", text: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      setBusy(null);
    }
  }, []);

  const refreshAnalytics = useCallback(async () => {
    setAnalyticsLoading(true);
    try {
      const [overview, report] = await Promise.all([
        getAnalyticsOverview(qualityDays),
        getQualityReport(qualityDays),
      ]);
      setAnalytics(overview);
      setQualityReport(report);
    } catch (reason) {
      setNotice({ type: "error", text: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      setAnalyticsLoading(false);
    }
  }, [qualityDays]);

  useEffect(() => void refresh(), [refresh]);

  // 同一工作区内 hash 变化不会重新挂载组件（App 的 key 是 workspace），
  // 因此路由参数变化时要主动同步视图与文档；依赖只在路由值真正变化时更新，
  // 不会覆盖用户在当前页面内的手动选择。
  useEffect(() => {
    setView(initialView ?? "documents");
    if (initialSource) setSelectedSource(initialSource);
  }, [initialView, initialSource]);

  // A4 引用定位:从「对话」工作区点引用跳过来时,定位到对应文档与分块。
  useEffect(
    () =>
      subscribeChunkTarget((target) => {
        setView("documents");
        setResult(null);
        setSelectedSource(target.source);
        setHighlightChunkIndex(target.chunkIndex);
      }),
    [],
  );

  useEffect(() => {
    if (view === "analytics") void refreshAnalytics();
  }, [refreshAnalytics, view]);

  useEffect(() => {
    // 只有文档视图需要分块预览；图谱/运营分析视图不应额外拉取分块（避免三视图重复请求）。
    if (view !== "documents" || !selectedSource) {
      setChunks([]);
      return;
    }
    listChunks(selectedSource)
      .then((response) => setChunks(response.chunks))
      .catch((reason) =>
        setNotice({
          type: "error",
          text: reason instanceof Error ? reason.message : String(reason),
        }),
      );
  }, [selectedSource, view]);

  const separatorError =
    settings.chunkStrategy === "fixed" ? validateSeparators(settings.separators) : null;
  const semanticUnavailable = settings.chunkStrategy === "semantic" && !stats?.embeddingsEnabled;
  const selectedDocument =
    stats?.sources.find((document) => document.source === selectedSource) ?? null;

  const upload = async (files: File[]) => {
    if (files.length === 0) return;
    if (separatorError) {
      setNotice({ type: "error", text: separatorError });
      return;
    }
    if (semanticUnavailable) {
      setNotice({ type: "error", text: "语义切分需要先配置 Embeddings 模型" });
      return;
    }
    setBusy("upload");
    setNotice(null);
    try {
      const ingested = await uploadDocuments(files, settings);
      await refresh();
      const text = `已入库 ${ingested.files} 个文件，生成 ${ingested.chunks} 个分块`;
      setNotice({ type: "success", text });
      void message.success(text);
    } catch (reason) {
      setNotice({ type: "error", text: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      setBusy(null);
    }
  };

  const doRemoveSource = async (source: string) => {
    try {
      const result = await deleteDocument(source);
      setSelectedSource(null);
      setChunks([]);
      await refresh();
      const removed = result?.graph;
      if (removed && (removed.entities > 0 || removed.relations > 0)) {
        const text = `已删除「${source}」，同时清理图谱 ${removed.entities} 个实体、${removed.relations} 条关系`;
        setNotice({ type: "success", text });
        void message.success(text);
      } else {
        const text = `已删除「${source}」`;
        setNotice({ type: "success", text });
        void message.success(text);
      }
    } catch (reason) {
      setNotice({ type: "error", text: reason instanceof Error ? reason.message : String(reason) });
    }
  };

  const setGraphRecall = useCallback((checked: boolean) => {
    setSettings((current) => ({ ...current, graphEnhance: checked }));
  }, []);

  const runQuery = useCallback(
    async (text: string) => {
      const value = text.trim();
      if (!value) return;
      setBusy("query");
      setNotice(null);
      try {
        setResult(
          await queryKnowledge({
            query: value,
            topK: settings.topK,
            generate: settings.generate,
            ...(settings.restrictToSelected && selectedSource ? { sources: [selectedSource] } : {}),
            // 开启时沿用服务端默认（含全局开关与可用性判断），不硬编码 true；
            // 关闭时由 recallOptions 同时关掉图谱与关键词，退化为「仅向量」召回。
            ...recallOptions(settings.graphEnhance),
          }),
        );
      } catch (reason) {
        setNotice({
          type: "error",
          text: reason instanceof Error ? reason.message : String(reason),
        });
      } finally {
        setBusy(null);
      }
    },
    [settings, selectedSource],
  );

  const saveDocumentMetadata = async (
    source: string,
    patch: { title: string; tags: string[]; allowedGroups: string[] },
  ) => {
    try {
      const response = await updateDocument(source, patch);
      setStats((current) =>
        current
          ? {
              ...current,
              sources: current.sources.map((document) =>
                document.source === source ? response.document : document,
              ),
            }
          : current,
      );
      setNotice({ type: "success", text: "文档信息已保存" });
      void message.success("文档信息已保存");
    } catch (reason) {
      setNotice({ type: "error", text: reason instanceof Error ? reason.message : String(reason) });
      throw reason;
    }
  };

  const sendFeedback = async (queryId: string, rating: QueryFeedbackRating) => {
    try {
      await submitQueryFeedback(queryId, rating);
      setFeedback((current) => ({ ...current, [queryId]: rating }));
      if (view === "analytics") await refreshAnalytics();
      setNotice({ type: "success", text: "反馈已记录" });
    } catch (reason) {
      setNotice({ type: "error", text: reason instanceof Error ? reason.message : String(reason) });
    }
  };

  const docColumns: ColumnsType<DocumentSource> = [
    {
      title: "知识来源",
      dataIndex: "source",
      key: "source",
      render: (_: unknown, record: DocumentSource) => (
        <Flex gap={8} align="center">
          <FileTextOutlined />
          <Flex vertical gap={0} style={{ minWidth: 0 }}>
            <Flex gap={4} align="center">
              <Typography.Text strong ellipsis title={record.title} style={{ maxWidth: 120 }}>
                {record.title}
              </Typography.Text>
              {record.ocrApplied ? (
                <Tag color="orange" style={{ margin: 0, fontSize: 11 }}>
                  OCR
                </Tag>
              ) : null}
              {record.ocrStatus === "ocr_needed" ? (
                <Tag
                  color="red"
                  style={{ margin: 0, fontSize: 11 }}
                  title="疑似扫描件，开OCR后重传"
                >
                  待OCR
                </Tag>
              ) : null}
              {record.ocrStatus === "ocr_failed" ? (
                <Tag
                  color="volcano"
                  style={{ margin: 0, fontSize: 11 }}
                  title="OCR失败，检查模型与日志"
                >
                  OCR失败
                </Tag>
              ) : null}
            </Flex>
            <Typography.Text
              type="secondary"
              ellipsis
              title={record.source}
              style={{ fontSize: 12, maxWidth: 150 }}
            >
              v{record.version} · {record.chunks} 个分块
            </Typography.Text>
          </Flex>
        </Flex>
      ),
    },
    {
      title: "操作",
      key: "actions",
      width: 60,
      render: (_: unknown, record: DocumentSource) => (
        <Popconfirm
          title={`确认删除知识来源“${record.source}”？`}
          description="全部分块与派生图谱一并清除，该操作不可恢复。"
          okText="确认删除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onConfirm={() => void doRemoveSource(record.source)}
        >
          <Tooltip title="删除来源">
            <Button
              type="text"
              danger
              size="small"
              icon={<DeleteOutlined />}
              aria-label={`删除 ${record.source}`}
              onClick={(event) => event.stopPropagation()}
            />
          </Tooltip>
        </Popconfirm>
      ),
    },
  ];

  // 「文档」「图谱」两个视图共用同一份知识来源列表：
  // 左侧选中哪篇文档，图谱面板就定位到哪篇，不必维护两套选择状态。
  const sourcesPanel = (
    <Card
      className="studio-split-layout__aside"
      size="small"
      title="知识来源"
      extra={<Tag>{stats?.sources.length ?? 0}</Tag>}
      style={{
        width: 320,
        flex: "0 0 auto",
        maxHeight: "100%",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
      styles={{
        body: {
          padding: 8,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        },
      }}
    >
      <Upload.Dragger
        multiple
        accept=".pdf,.txt,.md"
        showUploadList={false}
        disabled={busy === "upload" || Boolean(separatorError) || semanticUnavailable}
        beforeUpload={(file, fileList) => {
          void upload(fileList.length > 0 ? Array.from(fileList) : [file as unknown as File]);
          return false;
        }}
      >
        <Flex vertical align="center" gap={4} style={{ padding: "8px 0" }}>
          <CloudUploadOutlined style={{ fontSize: 20 }} />
          <Typography.Text strong style={{ fontSize: 12 }}>
            {busy === "upload" ? "入库中..." : "拖入文档或点击上传"}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            PDF、TXT、Markdown
          </Typography.Text>
        </Flex>
      </Upload.Dragger>
      {busy === "loading" ? (
        <Flex justify="center" style={{ padding: 24 }}>
          <Spin aria-label="正在加载知识库" />
        </Flex>
      ) : stats?.sources.length === 0 ? (
        <Empty description="拖入文档以创建知识来源" />
      ) : (
        <Table<DocumentSource>
          size="small"
          rowKey="source"
          columns={docColumns}
          dataSource={stats?.sources ?? []}
          pagination={
            (stats?.sources.length ?? 0) > 10 ? { pageSize: 10, showSizeChanger: false } : false
          }
          showHeader={false}
          onRow={(record) => ({
            onClick: () => {
              setSelectedSource(record.source);
              setHighlightChunkIndex(null);
            },
            style: {
              cursor: "pointer",
              background: record.source === selectedSource ? "var(--studio-selected)" : undefined,
            },
          })}
          locale={{ emptyText: <Empty description="拖入文档以创建知识来源" /> }}
        />
      )}
    </Card>
  );

  return (
    <StudioPage
      eyebrow="上下文工程 / RAG"
      title="知识库"
      description="上传文档构建知识来源，默认开启图谱检索做向量、关键词与图谱多路召回；关闭后仅走向量召回，并分析服务质量。"
      actions={
        <>
          <Segmented<RagView>
            aria-label="知识库视图"
            value={view}
            onChange={(value) => setView(value)}
            options={[
              { value: "documents", label: "文档", icon: <FileTextOutlined /> },
              { value: "graph", label: "图谱", icon: <NodeIndexOutlined /> },
              { value: "analytics", label: "运营分析", icon: <BarChartOutlined /> },
            ]}
          />
          <Badge status={stats?.embeddingsEnabled ? "success" : "default"} text="向量检索" />
          <Badge status={stats?.llmAvailable ? "success" : "default"} text="LLM" />
          <Badge status={stats?.ocrEnabled ? "success" : "default"} text="OCR" />
          <Button
            icon={<ReloadOutlined spin={busy === "loading" || analyticsLoading} />}
            disabled={busy !== null && busy !== "query"}
            onClick={() => {
              setNotice(null);
              if (view === "analytics") void refreshAnalytics();
              else void refresh();
            }}
          >
            刷新
          </Button>
        </>
      }
      extra={<StudioNotice notice={notice} />}
    >
      {view === "analytics" ? (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16 }}>
          <RagAnalyticsDashboard
            overview={analytics}
            report={qualityReport}
            loading={analyticsLoading}
            days={qualityDays}
            onDaysChange={setQualityDays}
          />
        </div>
      ) : view === "graph" ? (
        <Flex
          className="studio-split-layout"
          gap={12}
          align="flex-start"
          style={{ flex: 1, minHeight: 0, padding: 16, overflow: "hidden" }}
        >
          {sourcesPanel}
          <Flex
            className="studio-split-layout__main"
            vertical
            gap={12}
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              alignSelf: "stretch",
              overflow: "hidden",
            }}
          >
            <GraphPanel
              source={selectedSource}
              onSourceChange={setSelectedSource}
              documents={stats?.sources ?? []}
              documentsLoading={busy === "loading"}
            />
          </Flex>
        </Flex>
      ) : (
        <Flex
          className="studio-split-layout"
          gap={12}
          align="flex-start"
          style={{ flex: 1, minHeight: 0, padding: 16, overflow: "hidden" }}
        >
          {sourcesPanel}

          <Flex
            className="studio-split-layout__main"
            vertical
            gap={12}
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              alignSelf: "stretch",
              overflow: "hidden",
            }}
          >
            <Card size="small" title="检索预览" style={{ flex: "0 0 auto" }}>
              <QueryComposer
                busy={busy === "query"}
                draftRef={queryDraftRef}
                graphRecall={settings.graphEnhance}
                vectorRecallAvailable={Boolean(stats?.embeddingsEnabled)}
                graphRecallAvailable={stats?.graphRetrieval !== false}
                onGraphRecallChange={setGraphRecall}
                onRun={runQuery}
              />
            </Card>
            {result ? (
              <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
                <QueryPreview
                  result={result}
                  feedback={feedback[result.queryId]}
                  onFeedback={(rating) => void sendFeedback(result.queryId, rating)}
                />
              </div>
            ) : (
              <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
                <ChunkPreview
                  source={selectedSource}
                  chunks={chunks}
                  highlightChunkIndex={highlightChunkIndex}
                />
              </div>
            )}
          </Flex>

          <Card
            className="studio-split-layout__detail"
            size="small"
            title={
              <Flex gap={8} align="center">
                <SettingOutlined />
                <Typography.Text strong>检索设置</Typography.Text>
              </Flex>
            }
            style={{ width: 330, flex: "0 0 auto", maxHeight: "100%", overflowY: "auto" }}
          >
            {selectedDocument ? (
              <DocumentMetadataEditor
                document={selectedDocument}
                onSave={(patch) => saveDocumentMetadata(selectedDocument.source, patch)}
              />
            ) : null}
            <Form layout="vertical" preserve={false}>
              <Form.Item label="文档切分" extra="仅影响随后上传或重新入库的文档。">
                <Segmented<ChunkStrategy>
                  aria-label="切分模式"
                  value={settings.chunkStrategy}
                  onChange={(value) => setSettings({ ...settings, chunkStrategy: value })}
                  options={[
                    { value: "fixed", label: "固定切分" },
                    { value: "semantic", label: "语义切分", disabled: !stats?.embeddingsEnabled },
                  ]}
                  block
                />
              </Form.Item>
              {!stats?.embeddingsEnabled ? (
                <Alert
                  showIcon
                  type="info"
                  message="语义切分需要 Embeddings；当前仍可使用固定切分与 BM25 检索。"
                  style={{ marginBottom: 12 }}
                />
              ) : null}
              <Form.Item
                label={settings.chunkStrategy === "semantic" ? "最大分块长度" : "分块长度"}
              >
                <InputNumber
                  aria-label="分块长度"
                  min={1}
                  max={4000}
                  step={50}
                  value={settings.chunkSize}
                  onChange={(value) => setSettings({ ...settings, chunkSize: Number(value) || 1 })}
                  style={{ width: "100%" }}
                />
              </Form.Item>
              <Form.Item label="重叠长度">
                <InputNumber
                  aria-label="重叠长度"
                  min={0}
                  max={Math.max(0, settings.chunkSize - 1)}
                  step={10}
                  value={settings.chunkOverlap}
                  onChange={(value) =>
                    setSettings({ ...settings, chunkOverlap: Number(value) || 0 })
                  }
                  style={{ width: "100%" }}
                />
              </Form.Item>
              {settings.chunkStrategy === "semantic" ? (
                <Form.Item
                  label={`语义敏感度 ${Math.round(settings.semanticThreshold * 100)}%`}
                  extra="相邻句段相似度低于阈值时开启新分块；数值越高，切分越细。"
                >
                  <Slider
                    aria-label="语义敏感度"
                    min={0.5}
                    max={0.95}
                    step={0.05}
                    value={settings.semanticThreshold}
                    onChange={(value) => setSettings({ ...settings, semanticThreshold: value })}
                  />
                </Form.Item>
              ) : (
                <Form.Item
                  label={`分段标识符 ${settings.separators.length}/20`}
                  extra="一行一个，按顺序匹配。支持 \n、\t、\s（空格）。"
                  validateStatus={separatorError ? "error" : undefined}
                  help={separatorError ?? undefined}
                >
                  <Input.TextArea
                    aria-label="分段标识符"
                    rows={7}
                    value={separatorText}
                    onChange={(event) => {
                      const nextText = event.target.value;
                      setSeparatorText(nextText);
                      setSettings({ ...settings, separators: separatorsFromText(nextText) });
                    }}
                  />
                </Form.Item>
              )}
              <Form.Item
                label={`Top-K ${settings.topK}`}
                extra="向量 kNN、BM25 与图谱候选经 RRF 融合排序。"
              >
                <Slider
                  aria-label="Top-K"
                  min={1}
                  max={10}
                  value={settings.topK}
                  onChange={(value) => setSettings({ ...settings, topK: value })}
                />
              </Form.Item>
              <Form.Item
                label="仅当前文档"
                extra={selectedSource ? `限定 ${selectedSource}` : "请先选择文档"}
              >
                <Switch
                  aria-label="仅当前文档"
                  disabled={!selectedSource}
                  checked={settings.restrictToSelected}
                  onChange={(checked) => setSettings({ ...settings, restrictToSelected: checked })}
                />
              </Form.Item>
              <Form.Item label="生成回答" extra="召回后调用 LLM 生成答案">
                <Switch
                  aria-label="生成回答"
                  checked={settings.generate}
                  onChange={(checked) => setSettings({ ...settings, generate: checked })}
                />
              </Form.Item>
              <Card size="small" style={{ marginTop: 8 }}>
                <Statistic
                  title="已索引分块"
                  value={stats?.chunks ?? 0}
                  prefix={<DatabaseOutlined />}
                />
              </Card>
            </Form>
          </Card>
        </Flex>
      )}
    </StudioPage>
  );
}

function DocumentMetadataEditor({
  document,
  onSave,
}: {
  document: DocumentSource;
  onSave: (patch: { title: string; tags: string[]; allowedGroups: string[] }) => Promise<void>;
}) {
  const [title, setTitle] = useState(document.title);
  const [tagText, setTagText] = useState(document.tags.join(", "));
  const [groupText, setGroupText] = useState(document.allowedGroups.join(", "));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setTitle(document.title);
    setTagText(document.tags.join(", "));
    setGroupText(document.allowedGroups.join(", "));
  }, [document]);

  const tags = parseDelimitedStringList(tagText);
  const invalid =
    !title.trim() ||
    title.trim().length > 160 ||
    tags.length > 20 ||
    tags.some((tag) => tag.length > 40);
  const groups = parseDelimitedStringList(groupText);
  const groupsInvalid = groups.length > 50 || groups.some((group) => group.length > 60);

  return (
    <Card size="small" title={`资产信息 v${document.version}`} style={{ marginBottom: 12 }}>
      <Typography.Paragraph type="secondary" ellipsis={{ rows: 1 }} style={{ fontSize: 12 }}>
        {document.source}
      </Typography.Paragraph>
      <Form layout="vertical" preserve={false}>
        <Form.Item
          label="显示标题"
          required
          validateStatus={!title.trim() ? "error" : undefined}
          help={!title.trim() ? "标题不能为空" : undefined}
        >
          <Input
            aria-label="显示标题"
            value={title}
            maxLength={160}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Form.Item>
        <Form.Item
          label={`可见分组 ${groups.length}/50 · 留空公开`}
          validateStatus={groupsInvalid ? "error" : undefined}
          help="发布应用只会检索公开文档与调用方命中的分组；管理台检索不受此限制。"
        >
          <Input
            aria-label="可见分组"
            value={groupText}
            placeholder="hr, finance, leadership"
            onChange={(event) => setGroupText(event.target.value)}
          />
          {groupsInvalid ? (
            <Typography.Text type="danger" style={{ fontSize: 12 }}>
              分组需为 1-60 字符，最多 50 个
            </Typography.Text>
          ) : null}
        </Form.Item>
        <Form.Item label={`标签 ${tags.length}/20`}>
          <Input
            aria-label="标签"
            value={tagText}
            placeholder="产品, 生产, FAQ"
            onChange={(event) => setTagText(event.target.value)}
          />
        </Form.Item>
        {tags.length > 0 ? (
          <Flex gap={4} wrap style={{ marginBottom: 12 }}>
            {tags.map((tag) => (
              <Tag key={tag} icon={<TagOutlined />}>
                {tag}
              </Tag>
            ))}
          </Flex>
        ) : null}
        <Descriptions size="small" column={1} bordered>
          <Descriptions.Item label="类型">{document.mimeType}</Descriptions.Item>
          <Descriptions.Item label="大小">{formatBytes(document.byteSize, "--")}</Descriptions.Item>
          <Descriptions.Item label="切分策略">
            {document.chunkStrategy === "semantic"
              ? `语义 · ${Math.round((document.semanticThreshold ?? 0.75) * 100)}%`
              : `固定 · ${document.chunkSize}/${document.chunkOverlap}`}
          </Descriptions.Item>
          <Descriptions.Item label="更新">{formatDateTime(document.updatedAt)}</Descriptions.Item>
        </Descriptions>
        <Button
          type="default"
          block
          icon={<SaveOutlined />}
          loading={saving}
          disabled={invalid || groupsInvalid || saving}
          onClick={async () => {
            setSaving(true);
            try {
              await onSave({ title: title.trim(), tags, allowedGroups: groups });
            } finally {
              setSaving(false);
            }
          }}
          style={{ marginTop: 12 }}
        >
          {saving ? "保存中..." : "保存资产信息"}
        </Button>
      </Form>
    </Card>
  );
}

/**
 * 检索链路摘要：把「本次实际用了哪几路」说清楚。
 * keywordEnabled/graphEnabled 缺省（老服务端）时按启用处理，避免误报成仅向量。
 */
function retrievalLabel(retrieval: {
  embeddingsEnabled: boolean;
  keywordEnabled?: boolean;
  graphEnabled?: boolean;
}): string {
  const channels = [
    `向量${retrieval.embeddingsEnabled ? "开" : "关"}`,
    retrieval.keywordEnabled === false ? "关键词关" : "关键词开",
    retrieval.graphEnabled === false ? "图谱关" : "图谱开",
  ];
  return channels.join(" · ");
}

const previewCardStyle = {
  height: "100%",
  display: "flex",
  flexDirection: "column" as const,
  minHeight: 0,
  overflow: "hidden",
};

const previewCardStyles = {
  body: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto" as const,
    overscrollBehavior: "contain" as const,
  },
};

/**
 * 检索问题输入框单独持有草稿状态。
 *
 * 之前 `query` 放在 RagWorkspace 顶层：每敲一个字都会重渲染整个知识库页面，
 * 其中「分块预览」一次挂载上千条分块，单次按键的主线程耗时接近 1s。
 * 把击键状态限制在这个小组件内，输入不再触发页面级重渲染。
 */
const QueryComposer = memo(function QueryComposer({
  busy,
  draftRef,
  graphRecall,
  vectorRecallAvailable,
  graphRecallAvailable,
  onGraphRecallChange,
  onRun,
}: {
  busy: boolean;
  /** 草稿只在 ref 中留存：切走视图再回来不丢输入，也不会触发父级重渲染。 */
  draftRef: { current: string };
  /** 图谱检索（多路召回）开关；关闭时退化为仅向量召回。 */
  graphRecall: boolean;
  /** 向量通道是否可用（Embeddings 是否配置）；关闭图谱检索时用于提示空召回风险。 */
  vectorRecallAvailable: boolean;
  /** 部署侧是否允许图谱检索（RAG_GRAPH_RETRIEVAL）；false 时勾选无效。 */
  graphRecallAvailable: boolean;
  onGraphRecallChange: (checked: boolean) => void;
  onRun: (text: string) => void;
}) {
  const [text, setText] = useState(draftRef.current);
  const canRun = text.trim().length > 0 && !busy;
  return (
    <Flex vertical gap={8}>
      <Flex gap={8} align="flex-start">
        <Input.TextArea
          aria-label="检索问题"
          rows={2}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            draftRef.current = event.target.value;
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && canRun) onRun(text);
          }}
          placeholder="输入问题，预览召回片段与生成结果"
          style={{ flex: 1 }}
        />
        <Button
          type="primary"
          icon={<SearchOutlined />}
          loading={busy}
          disabled={!canRun}
          onClick={() => onRun(text)}
        >
          {busy ? "检索中..." : "运行检索"}
        </Button>
      </Flex>
      <Flex gap={8} align="center" wrap>
        <Checkbox
          aria-label="图谱检索多路召回"
          checked={graphRecall && graphRecallAvailable}
          disabled={!graphRecallAvailable}
          onChange={(event) => onGraphRecallChange(event.target.checked)}
        >
          <Typography.Text strong style={{ fontSize: 12 }}>
            图谱检索（多路召回）
          </Typography.Text>
        </Checkbox>
        <Typography.Text
          type={
            (!graphRecall || !graphRecallAvailable) && !vectorRecallAvailable
              ? "warning"
              : "secondary"
          }
          style={{ fontSize: 12 }}
        >
          {!graphRecallAvailable
            ? "服务端已通过 RAG_GRAPH_RETRIEVAL 全局关闭图谱检索：本次检索仅使用向量召回。"
            : graphRecall
              ? "向量 + 关键词 + 图谱三路并行召回，命中分块经 RRF 融合排序。"
              : vectorRecallAvailable
                ? "已关闭图谱召回：仅从向量检索召回实体分块。"
                : "已关闭图谱召回，但当前未配置 Embeddings：仅向量模式将无法召回内容，请先配置向量模型。"}
        </Typography.Text>
      </Flex>
    </Flex>
  );
});

const ChunkPreview = memo(function ChunkPreview({
  source,
  chunks,
  highlightChunkIndex,
}: {
  source: string | null;
  chunks: ChunkInfo[];
  highlightChunkIndex?: number | null;
}) {
  const highlightRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (highlightChunkIndex == null) return;
    highlightRef.current?.scrollIntoView({ block: "nearest" });
  }, [highlightChunkIndex, chunks]);

  return (
    <Card
      size="small"
      title="分块预览"
      extra={<Tag>{source ? `${chunks.length} chunks` : "未选择"}</Tag>}
      style={previewCardStyle}
      styles={previewCardStyles}
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        {source ?? "未选择知识来源"}
      </Typography.Paragraph>
      {!source ? (
        <Empty description="从左侧选择文档查看切分结果" />
      ) : (
        <List
          size="small"
          dataSource={chunks}
          rowKey="id"
          locale={{ emptyText: <Empty description="暂无分块" /> }}
          renderItem={(chunk) => {
            const isHighlighted =
              highlightChunkIndex != null && chunk.chunkIndex === highlightChunkIndex;
            return (
              <List.Item
                style={isHighlighted ? { background: "#fff7e6", borderRadius: 8 } : undefined}
              >
                <List.Item.Meta
                  title={
                    <Flex gap={8} align="center" wrap>
                      <Tag>#{String(chunk.chunkIndex + 1).padStart(2, "0")}</Tag>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {chunk.length} 字符
                      </Typography.Text>
                      <Tag color={chunk.hasEmbedding ? "success" : "default"}>
                        {chunk.hasEmbedding ? "VECTOR" : "BM25"}
                      </Tag>
                    </Flex>
                  }
                  description={
                    <Typography.Paragraph style={{ fontSize: 12, marginBottom: 0 }}>
                      {chunk.content}
                    </Typography.Paragraph>
                  }
                />
                {isHighlighted ? <span ref={highlightRef as unknown as undefined} /> : null}
              </List.Item>
            );
          }}
        />
      )}
    </Card>
  );
});

function QueryPreview({
  result,
  feedback,
  onFeedback,
}: {
  result: QueryResult;
  feedback?: QueryFeedbackRating;
  onFeedback: (rating: QueryFeedbackRating) => void;
}) {
  const retrieval = result.retrieval;
  const graph = result.graph;
  return (
    <Card
      size="small"
      title="检索预览"
      style={previewCardStyle}
      styles={previewCardStyles}
      extra={
        <Flex gap={4} align="center">
          <Tag>{result.chunks.length} hits</Tag>
          <Tooltip title="复制 queryId 用于审计回溯">
            <Typography.Text
              copyable={{ text: result.queryId }}
              type="secondary"
              style={{ fontSize: 12 }}
              title={result.queryId}
            >
              {result.queryId.slice(0, 8)}
            </Typography.Text>
          </Tooltip>
          <Tooltip title="有用">
            <Button
              type={feedback === "positive" ? "primary" : "text"}
              size="small"
              icon={<LikeOutlined />}
              aria-label="检索结果有用"
              onClick={() => onFeedback("positive")}
            />
          </Tooltip>
          <Tooltip title="无用">
            <Button
              type={feedback === "negative" ? "primary" : "text"}
              danger={feedback === "negative"}
              size="small"
              icon={<DislikeOutlined />}
              aria-label="检索结果无用"
              onClick={() => onFeedback("negative")}
            />
          </Tooltip>
        </Flex>
      }
    >
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        {result.query}
      </Typography.Title>
      {result.usage ? (
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          <UsageTag usage={result.usage} />
        </Typography.Paragraph>
      ) : null}
      {retrieval ? (
        <Collapse
          size="small"
          style={{ marginBottom: 12 }}
          items={[
            {
              key: "retrieval",
              label: `检索链路 · ${retrieval.store} · ${retrievalLabel(retrieval)} · RRF k=${retrieval.rrfK}`,
              children: (
                <Flex vertical gap={8}>
                  <Descriptions size="small" column={2} bordered>
                    <Descriptions.Item label="向量耗时">
                      {retrieval.timingsMs.vectorMs === null
                        ? "未启用"
                        : `${retrieval.timingsMs.vectorMs} ms`}
                    </Descriptions.Item>
                    <Descriptions.Item label="关键词耗时">
                      {`${retrieval.timingsMs.keywordMs} ms`}
                    </Descriptions.Item>
                    <Descriptions.Item label="向量候选">
                      {retrieval.vectorHits.length}
                    </Descriptions.Item>
                    <Descriptions.Item label="关键词候选">
                      {retrieval.keywordHits.length}
                    </Descriptions.Item>
                    <Descriptions.Item label="图谱候选">
                      {retrieval.graphHits?.length ?? 0}
                    </Descriptions.Item>
                    <Descriptions.Item label="图谱耗时">
                      {retrieval.timingsMs.graphMs === undefined ||
                      retrieval.timingsMs.graphMs === null
                        ? "—"
                        : `${retrieval.timingsMs.graphMs} ms`}
                    </Descriptions.Item>
                  </Descriptions>
                  {retrieval.graphEnabled === false ? (
                    <Alert
                      type="info"
                      showIcon
                      message={retrieval.keywordEnabled === false ? "仅向量召回" : "图谱检索未启用"}
                      description={
                        retrieval.keywordEnabled === false
                          ? "本次检索关闭了图谱与关键词通道，只从向量检索召回；重新勾选「图谱检索（多路召回）」可恢复三路。"
                          : "本次检索关闭了图谱通道，只融合向量与关键词两路。"
                      }
                    />
                  ) : null}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {RRF_CHANNEL_HINT}
                  </Typography.Text>
                </Flex>
              ),
            },
          ]}
        />
      ) : (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="老服务端未返回检索明细，仅展示 RRF 融合分。升级 rag-server 后可区分向量/关键词/图谱分数。"
        />
      )}
      <GraphAugmentationCard graph={graph} graphEnabled={retrieval?.graphEnabled} />
      {result.generate ? (
        <Card size="small" type="inner" title="ANSWER" style={{ marginBottom: 12 }}>
          {result.answer ? (
            <Typography.Paragraph style={{ fontSize: 13 }}>{result.answer}</Typography.Paragraph>
          ) : (
            <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
              {result.llmAvailable ? "没有足够资料生成回答。" : "LLM 未启用，仅展示检索结果。"}
            </Typography.Paragraph>
          )}
        </Card>
      ) : null}
      <List
        size="small"
        dataSource={result.chunks}
        rowKey="id"
        renderItem={(chunk, index) => {
          const debug = chunk.debug;
          const tag = channelLabel(debug?.channels ?? []);
          return (
            <List.Item>
              <List.Item.Meta
                title={
                  <Flex gap={8} align="center" wrap>
                    <Tag>#{String(index + 1).padStart(2, "0")}</Tag>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {chunk.source} · 第 {chunk.chunkIndex + 1} 段
                    </Typography.Text>
                    <Tag color={tag.color}>{tag.label}</Tag>
                  </Flex>
                }
                description={
                  <Flex vertical gap={4}>
                    <Flex gap={4} wrap>
                      <Tooltip title="RRF 融合分（最终排序依据，越大越相关）">
                        <Tag color="gold">RRF {chunk.score.toFixed(4)}</Tag>
                      </Tooltip>
                      <Tooltip
                        title={
                          debug
                            ? `向量余弦分（候选排名 #${debug.vectorRank !== null ? debug.vectorRank + 1 : "-"}）`
                            : "向量原始分（老服务端无此字段）"
                        }
                      >
                        <Tag color="blue">
                          向量{" "}
                          {debug?.vectorScore !== null && debug?.vectorScore !== undefined
                            ? debug.vectorScore.toFixed(4)
                            : "—"}
                          {debug?.vectorRank !== null && debug?.vectorRank !== undefined
                            ? ` #${debug.vectorRank + 1}`
                            : ""}
                        </Tag>
                      </Tooltip>
                      <Tooltip
                        title={
                          debug
                            ? `BM25 分（候选排名 #${debug.keywordRank !== null ? debug.keywordRank + 1 : "-"}，绝对值只可同路比较）`
                            : "BM25 原始分（老服务端无此字段）"
                        }
                      >
                        <Tag color="green">
                          关键词{" "}
                          {debug?.keywordScore !== null && debug?.keywordScore !== undefined
                            ? debug.keywordScore.toFixed(4)
                            : "—"}
                          {debug?.keywordRank !== null && debug?.keywordRank !== undefined
                            ? ` #${debug.keywordRank + 1}`
                            : ""}
                        </Tag>
                      </Tooltip>
                      <Tooltip
                        title={
                          debug
                            ? `图谱分（子图关系权重归一化，候选排名 #${debug.graphRank !== null && debug.graphRank !== undefined ? debug.graphRank + 1 : "-"}）`
                            : "图谱原始分（老服务端无此字段）"
                        }
                      >
                        <Tag color="volcano">
                          图谱{" "}
                          {debug?.graphScore !== null && debug?.graphScore !== undefined
                            ? debug.graphScore.toFixed(4)
                            : "—"}
                          {debug?.graphRank !== null && debug?.graphRank !== undefined
                            ? ` #${debug.graphRank + 1}`
                            : ""}
                        </Tag>
                      </Tooltip>
                    </Flex>
                    <Typography.Paragraph style={{ fontSize: 12, marginBottom: 0 }}>
                      {chunk.content}
                    </Typography.Paragraph>
                  </Flex>
                }
              />
            </List.Item>
          );
        }}
      />
    </Card>
  );
}

/**
 * 「知识图谱增强」卡片。
 *
 * 命中 0 条或未启用时仍给出明确说明，但不渲染空的种子/上下文区域，
 * 避免用户以为界面加载失败；完全没有 graph 字段（老服务端）时整卡不渲染。
 */
function GraphAugmentationCard({
  graph,
  graphEnabled,
}: {
  graph?: GraphQueryAugmentation;
  graphEnabled?: boolean;
}) {
  if (!graph) return null;
  const inactive = graph.enabled === false || graphEnabled === false;
  const noHits = !inactive && graph.chunkHits === 0;
  if (inactive || noHits) {
    // 未启用/未命中时只留一句解释，不渲染空的种子与上下文区块。
    return (
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="知识图谱增强"
        description={
          inactive
            ? "图谱检索未启用：本次检索仅使用向量召回。"
            : "图谱增强已启用，但本次问题未命中任何图谱实体，未产生图谱候选分块。"
        }
      />
    );
  }
  return (
    <Card
      size="small"
      type="inner"
      title="知识图谱增强"
      extra={<Tag color="volcano">{graph.chunkHits} 分块回溯</Tag>}
      style={{ marginBottom: 12 }}
    >
      <Flex vertical gap={8}>
        <Flex gap={12} wrap>
          <Typography.Text style={{ fontSize: 12 }}>
            实体 <strong>{graph.entities}</strong>
          </Typography.Text>
          <Typography.Text style={{ fontSize: 12 }}>
            关系 <strong>{graph.relations}</strong>
          </Typography.Text>
          <Typography.Text style={{ fontSize: 12 }}>
            回溯分块 <strong>{graph.chunkHits}</strong>
          </Typography.Text>
        </Flex>
        <Flex gap={4} wrap align="center">
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            种子实体：
          </Typography.Text>
          {graph.seeds.length === 0 ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              无
            </Typography.Text>
          ) : (
            graph.seeds.map((seed) => (
              <Tag key={seed.id} color="volcano">
                {seed.name}
                {seed.type ? ` · ${seed.type}` : ""}
              </Tag>
            ))
          )}
        </Flex>
        {graph.context ? (
          <Collapse
            size="small"
            items={[
              {
                key: "graph-context",
                label: "图谱上下文（子图三元组，参与提示词增强）",
                children: (
                  <Typography.Paragraph
                    code
                    style={{ fontSize: 12, whiteSpace: "pre-wrap", marginBottom: 0 }}
                  >
                    {graph.context}
                  </Typography.Paragraph>
                ),
              },
            ]}
          />
        ) : null}
      </Flex>
    </Card>
  );
}
