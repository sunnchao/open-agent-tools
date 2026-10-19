import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  Descriptions,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  List,
  Popconfirm,
  Progress,
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
  ReloadOutlined,
  SaveOutlined,
  SearchOutlined,
  SettingOutlined,
  TagOutlined,
} from "../../lib/icons.js";
import { StudioPage } from "../../components/studio/StudioPageHeader.js";
import { StudioNotice, type StudioNoticeValue } from "../../components/studio/StudioNotice.js";
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
  type AnalyticsOverview,
  type ChunkInfo,
  type ChunkStrategy,
  type DocumentSource,
  type DocumentStats,
  type QueryFeedbackRating,
  type QueryResult,
  type QualityReport,
} from "./api.js";
import { subscribeChunkTarget } from "./chunkTarget.js";

interface RagSettings {
  chunkSize: number;
  chunkOverlap: number;
  chunkStrategy: ChunkStrategy;
  separators: string[];
  semanticThreshold: number;
  topK: number;
  generate: boolean;
  restrictToSelected: boolean;
}

const defaultSeparators = ["\n\n", "\n", "。", "！", "？", ". ", " "];

const defaultSettings: RagSettings = {
  chunkSize: 1024,
  chunkOverlap: 50,
  chunkStrategy: "fixed",
  separators: defaultSeparators,
  semanticThreshold: 0.75,
  topK: 5,
  generate: true,
  restrictToSelected: false,
};

export function RagWorkspace() {
  const { message } = App.useApp();
  const settingsInitialized = useRef(false);
  const [stats, setStats] = useState<DocumentStats | null>(null);
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [chunks, setChunks] = useState<ChunkInfo[]>([]);
  const [highlightChunkIndex, setHighlightChunkIndex] = useState<number | null>(null);
  const [settings, setSettings] = useState<RagSettings>(defaultSettings);
  const [separatorText, setSeparatorText] = useState(() => separatorsToText(defaultSeparators));
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [view, setView] = useState<"documents" | "analytics">("documents");
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
      setSelectedSource((current) => current ?? next.sources[0]?.source ?? null);
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
    if (!selectedSource) {
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
  }, [selectedSource]);

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

  const runQuery = async () => {
    if (!query.trim()) return;
    setBusy("query");
    setNotice(null);
    try {
      setResult(
        await queryKnowledge({
          query: query.trim(),
          topK: settings.topK,
          generate: settings.generate,
          ...(settings.restrictToSelected && selectedSource ? { sources: [selectedSource] } : {}),
        }),
      );
    } catch (reason) {
      setNotice({ type: "error", text: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      setBusy(null);
    }
  };

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
            <Typography.Text strong ellipsis title={record.title} style={{ maxWidth: 150 }}>
              {record.title}
            </Typography.Text>
            <Typography.Text type="secondary" ellipsis title={record.source} style={{ fontSize: 12, maxWidth: 150 }}>
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

  return (
    <StudioPage
      eyebrow="上下文工程 / RAG"
      title="知识库"
      description="上传文档构建知识来源，预览召回片段，分析服务质量。"
      actions={
        <>
          <Segmented<"documents" | "analytics">
            aria-label="知识库视图"
            value={view}
            onChange={(value) => setView(value)}
            options={[
              { value: "documents", label: "文档", icon: <FileTextOutlined /> },
              { value: "analytics", label: "运营分析", icon: <BarChartOutlined /> },
            ]}
          />
          <Badge status={stats?.embeddingsEnabled ? "success" : "default"} text="向量检索" />
          <Badge status={stats?.llmAvailable ? "success" : "default"} text="LLM" />
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
      ) : (
        <Flex gap={12} align="flex-start" style={{ flex: 1, minHeight: 0, padding: 16, overflow: "hidden" }}>
          <Card
            size="small"
            title="知识来源"
            extra={<Tag>{stats?.sources.length ?? 0}</Tag>}
            style={{ width: 320, flex: "0 0 auto", maxHeight: "100%", overflow: "hidden", display: "flex", flexDirection: "column" }}
            styles={{ body: { padding: 8, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 } }}
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
                pagination={false}
                showHeader={false}
                onRow={(record) => ({
                  onClick: () => {
                    setSelectedSource(record.source);
                    setHighlightChunkIndex(null);
                  },
                  style: {
                    cursor: "pointer",
                    background: record.source === selectedSource ? "#f0f5ff" : undefined,
                  },
                })}
                locale={{ emptyText: <Empty description="拖入文档以创建知识来源" /> }}
              />
            )}
          </Card>

          <Flex vertical gap={12} style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
            <Card size="small" title="检索预览">
              <Flex gap={8} align="flex-start">
                <Input.TextArea
                  aria-label="检索问题"
                  rows={2}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void runQuery();
                  }}
                  placeholder="输入问题，预览召回片段与生成结果"
                  style={{ flex: 1 }}
                />
                <Button
                  type="primary"
                  icon={<SearchOutlined />}
                  loading={busy === "query"}
                  disabled={!query.trim() || busy === "query"}
                  onClick={() => void runQuery()}
                >
                  {busy === "query" ? "检索中..." : "运行检索"}
                </Button>
              </Flex>
            </Card>
            {result ? (
              <QueryPreview
                result={result}
                feedback={feedback[result.queryId]}
                onFeedback={(rating) => void sendFeedback(result.queryId, rating)}
              />
            ) : (
              <ChunkPreview
                source={selectedSource}
                chunks={chunks}
                highlightChunkIndex={highlightChunkIndex}
              />
            )}
          </Flex>

          <Card
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
              <Form.Item label={settings.chunkStrategy === "semantic" ? "最大分块长度" : "分块长度"}>
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
                  onChange={(value) => setSettings({ ...settings, chunkOverlap: Number(value) || 0 })}
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
              <Form.Item label={`Top-K ${settings.topK}`} extra="混合检索使用向量 kNN 与 BM25，经 RRF 融合排序。">
                <Slider
                  aria-label="Top-K"
                  min={1}
                  max={10}
                  value={settings.topK}
                  onChange={(value) => setSettings({ ...settings, topK: value })}
                />
              </Form.Item>
              <Form.Item label="仅当前文档" extra={selectedSource ? `限定 ${selectedSource}` : "请先选择文档"}>
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

function separatorsToText(separators: readonly string[]): string {
  return separators
    .map((separator) =>
      separator
        .replaceAll("\\", "\\\\")
        .replaceAll("\n", "\\n")
        .replaceAll("\r", "\\r")
        .replaceAll("\t", "\\t")
        .replaceAll(" ", "\\s"),
    )
    .join("\n");
}

function separatorsFromText(value: string): string[] {
  const separators = value
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) =>
      line.replace(/\\(\\|n|r|t|s)/g, (_match, escape: string) => {
        if (escape === "n") return "\n";
        if (escape === "r") return "\r";
        if (escape === "t") return "\t";
        if (escape === "s") return " ";
        return "\\";
      }),
    );
  return separators.filter((separator, index) => separators.indexOf(separator) === index);
}

function validateSeparators(separators: readonly string[]): string | null {
  if (separators.length === 0) return "请至少配置一个分段标识符";
  if (separators.length > 20) return "分段标识符不能超过 20 个";
  if (separators.some((separator) => Array.from(separator).length > 32)) {
    return "单个分段标识符不能超过 32 个字符";
  }
  return null;
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

  const tags = tagText
    .split(/[,，\n]/)
    .map((tag) => tag.trim())
    .filter((tag, index, all) => Boolean(tag) && all.indexOf(tag) === index);
  const invalid =
    !title.trim() ||
    title.trim().length > 160 ||
    tags.length > 20 ||
    tags.some((tag) => tag.length > 40);
  const groups = groupText
    .split(/[,，\n]/)
    .map((group) => group.trim())
    .filter((group, index, all) => Boolean(group) && all.indexOf(group) === index);
  const groupsInvalid = groups.length > 50 || groups.some((group) => group.length > 60);

  return (
    <Card size="small" title={`资产信息 v${document.version}`} style={{ marginBottom: 12 }}>
      <Typography.Paragraph type="secondary" ellipsis={{ rows: 1 }} style={{ fontSize: 12 }}>
        {document.source}
      </Typography.Paragraph>
      <Form layout="vertical" preserve={false}>
        <Form.Item label="显示标题" required validateStatus={!title.trim() ? "error" : undefined} help={!title.trim() ? "标题不能为空" : undefined}>
          <Input aria-label="显示标题" value={title} maxLength={160} onChange={(event) => setTitle(event.target.value)} />
        </Form.Item>
        <Form.Item label={`可见分组 ${groups.length}/50 · 留空公开`} validateStatus={groupsInvalid ? "error" : undefined} help="发布应用只会检索公开文档与调用方命中的分组；管理台检索不受此限制。">
          <Input
            aria-label="可见分组"
            value={groupText}
            placeholder="hr, finance, leadership"
            onChange={(event) => setGroupText(event.target.value)}
          />
          {groupsInvalid ? <Typography.Text type="danger" style={{ fontSize: 12 }}>分组需为 1-60 字符，最多 50 个</Typography.Text> : null}
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
              <Tag key={tag} icon={<TagOutlined />}>{tag}</Tag>
            ))}
          </Flex>
        ) : null}
        <Descriptions size="small" column={1} bordered>
          <Descriptions.Item label="类型">{document.mimeType}</Descriptions.Item>
          <Descriptions.Item label="大小">{formatBytes(document.byteSize)}</Descriptions.Item>
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

function RagAnalyticsDashboard({
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
  const recentColumns: ColumnsType<AnalyticsOverview["recent"][number]> = [
    { title: "问题", dataIndex: "query", key: "query", ellipsis: true, render: (value: string, record) => <Typography.Text ellipsis title={record.error ?? value} style={{ maxWidth: 240 }}>{value}</Typography.Text> },
    { title: "命中", dataIndex: "hitCount", key: "hitCount", width: 70, render: (_: unknown, record) => (record.error ? "失败" : record.hitCount) },
    { title: "延迟", dataIndex: "latencyMs", key: "latencyMs", width: 90, render: (value: number) => `${value} ms` },
    {
      title: "反馈",
      dataIndex: "feedback",
      key: "feedback",
      width: 70,
      render: (value: string | null) => (value === "positive" ? "有用" : value === "negative" ? "无用" : "--"),
    },
    {
      title: "归因",
      dataIndex: "attribution",
      key: "attribution",
      width: 100,
      render: (value: AnalyticsOverview["recent"][number]["attribution"]) => <Tag>{attributionLabel(value)}</Tag>,
    },
    { title: "时间", dataIndex: "createdAt", key: "createdAt", width: 110, render: (value: string) => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{formatDateTime(value)}</Typography.Text> },
  ];
  return (
    <Flex vertical gap={12}>
      <Flex align="flex-start" justify="space-between" gap={12} wrap>
        <Flex vertical gap={2}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>最近 {days} 天</Typography.Text>
          <Typography.Title level={5} style={{ margin: 0 }}>知识库服务质量</Typography.Title>
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
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{loading ? "更新中" : "实时汇总"}</Typography.Text>
        </Flex>
      </Flex>

      <Flex gap={12} wrap>
        <Card size="small" style={{ flex: "1 1 160px" }}>
          <Statistic title="查询总量" value={overview.totals.queries} suffix={`失败 ${overview.totals.failed}`} />
        </Card>
        <Card size="small" style={{ flex: "1 1 160px", borderColor: quality && quality.hitRate < 0.75 ? "#d98a2b" : undefined }}>
          <Statistic
            title="检索命中率"
            value={quality ? Math.round(quality.hitRate * 100) : "--"}
            suffix={quality ? "%" : ""}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{quality ? `${quality.hits} 次命中文档` : "正在汇总归因"}</Typography.Text>
        </Card>
        <Card size="small" style={{ flex: "1 1 160px", borderColor: quality && quality.noAnswerRate > 0.25 ? "#d98a2b" : undefined }}>
          <Statistic
            title="无答案率"
            value={quality ? Math.round(quality.noAnswerRate * 100) : "--"}
            suffix={quality ? "%" : ""}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{quality ? `${quality.noAnswer} 次无答案` : "正在汇总归因"}</Typography.Text>
        </Card>
        <Card size="small" style={{ flex: "1 1 160px" }}>
          <Statistic title="平均延迟" value={overview.totals.averageLatencyMs} suffix="ms" />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>含检索与生成</Typography.Text>
        </Card>
        <Card size="small" style={{ flex: "1 1 160px", borderColor: overview.totals.noHitRate > 0.25 ? "#d98a2b" : undefined }}>
          <Statistic title="空召回" value={overview.totals.noHits} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{Math.round(overview.totals.noHitRate * 100)}% 的成功请求</Typography.Text>
        </Card>
        <Card size="small" style={{ flex: "1 1 160px" }}>
          <Statistic
            title="用户好评"
            value={helpful === null ? "--" : Math.round(helpful * 100)}
            suffix={helpful === null ? "" : "%"}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{overview.totals.positiveFeedback + overview.totals.negativeFeedback} 条反馈</Typography.Text>
        </Card>
      </Flex>

      <Flex gap={12} align="flex-start" wrap>
        <Card size="small" title="无答案归因" extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>按实际检索与生成结果</Typography.Text>} style={{ flex: "1 1 320px" }}>
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
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{hint}</Typography.Text>
                        </Flex>
                        <Typography.Text strong>{count}</Typography.Text>
                      </Flex>
                      <Progress percent={Math.round((count / total) * 100)} showInfo={false} size="small" />
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

        <Card size="small" title="Top 未覆盖问题" extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>按出现次数</Typography.Text>} style={{ flex: "1 1 280px" }}>
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
                    title={<Typography.Text ellipsis title={item.query}>{item.query}</Typography.Text>}
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
        <Card size="small" title="质量趋势" extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>柱高为每日查询量，橙色为无答案</Typography.Text>} style={{ flex: "2 1 420px" }}>
          <Flex gap={4} align="flex-end" style={{ minHeight: 120 }}>
            {(report?.trend ?? []).map((day) => (
              <Tooltip key={day.date} title={`${day.date}: ${day.queries} 次查询，${day.noAnswer} 次无答案`}>
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

        <Card size="small" title="热门知识来源" extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>按召回片段数</Typography.Text>} style={{ flex: "1 1 240px" }}>
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
                  <Typography.Text ellipsis title={source.source} style={{ flex: 1 }}>{source.source}</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>{source.hits} hits</Typography.Text>
                </List.Item>
              )}
            />
          )}
        </Card>
      </Flex>

      <Card
        size="small"
        title="最近查询"
        extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>最多展示 20 条</Typography.Text>}
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

function formatBytes(bytes: number): string {
  if (!bytes) return "--";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "--";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function ChunkPreview({
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
              <List.Item style={isHighlighted ? { background: "#fff7e6", borderRadius: 8 } : undefined}>
                <List.Item.Meta
                  title={
                    <Flex gap={8} align="center" wrap>
                      <Tag>#{String(chunk.chunkIndex + 1).padStart(2, "0")}</Tag>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{chunk.length} 字符</Typography.Text>
                      <Tag color={chunk.hasEmbedding ? "success" : "default"}>{chunk.hasEmbedding ? "VECTOR" : "BM25"}</Tag>
                    </Flex>
                  }
                  description={<Typography.Paragraph style={{ fontSize: 12, marginBottom: 0 }}>{chunk.content}</Typography.Paragraph>}
                />
                {isHighlighted ? <span ref={highlightRef as unknown as undefined} /> : null}
              </List.Item>
            );
          }}
        />
      )}
    </Card>
  );
}

function QueryPreview({
  result,
  feedback,
  onFeedback,
}: {
  result: QueryResult;
  feedback?: QueryFeedbackRating;
  onFeedback: (rating: QueryFeedbackRating) => void;
}) {
  return (
    <Card
      size="small"
      title="检索预览"
      extra={
        <Flex gap={4} align="center">
          <Tag>{result.chunks.length} hits</Tag>
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
      <Typography.Title level={5} style={{ marginTop: 0 }}>{result.query}</Typography.Title>
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
        renderItem={(chunk, index) => (
          <List.Item>
            <List.Item.Meta
              title={
                <Flex gap={8} align="center" wrap>
                  <Tag>#{String(index + 1).padStart(2, "0")}</Tag>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {chunk.source} · 第 {chunk.chunkIndex + 1} 段
                  </Typography.Text>
                  <Tag>{chunk.score.toFixed(4)}</Tag>
                </Flex>
              }
              description={<Typography.Paragraph style={{ fontSize: 12, marginBottom: 0 }}>{chunk.content}</Typography.Paragraph>}
            />
          </List.Item>
        )}
      />
    </Card>
  );
}
