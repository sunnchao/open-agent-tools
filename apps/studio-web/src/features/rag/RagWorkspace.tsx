import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  BarChartOutlined,
  CheckCircleFilled,
  CloudUploadOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  FileTextOutlined,
  DislikeOutlined,
  LikeOutlined,
  ReloadOutlined,
  SaveOutlined,
  SearchOutlined,
  SettingOutlined,
  TagOutlined,
} from "../../lib/icons.js";
import {
  deleteDocument,
  getAnalyticsOverview,
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
} from "./api.js";

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
  const fileInput = useRef<HTMLInputElement>(null);
  const settingsInitialized = useRef(false);
  const [stats, setStats] = useState<DocumentStats | null>(null);
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [chunks, setChunks] = useState<ChunkInfo[]>([]);
  const [settings, setSettings] = useState<RagSettings>(defaultSettings);
  const [separatorText, setSeparatorText] = useState(() => separatorsToText(defaultSeparators));
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [view, setView] = useState<"documents" | "analytics">("documents");
  const [analytics, setAnalytics] = useState<AnalyticsOverview | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [feedback, setFeedback] = useState<Record<string, QueryFeedbackRating>>({});
  const [busy, setBusy] = useState<"loading" | "upload" | "query" | null>("loading");
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<{ type: "error" | "success"; text: string } | null>(null);

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
      setAnalytics(await getAnalyticsOverview());
    } catch (reason) {
      setNotice({ type: "error", text: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      setAnalyticsLoading(false);
    }
  }, []);

  useEffect(() => void refresh(), [refresh]);

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
      setNotice({
        type: "success",
        text: `已入库 ${ingested.files} 个文件，生成 ${ingested.chunks} 个分块`,
      });
    } catch (reason) {
      setNotice({ type: "error", text: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      setBusy(null);
    }
  };

  const removeSource = async (source: string) => {
    if (
      !window.confirm(
        `确认删除知识来源“${source}”？\n\n该来源的全部分块，以及由它抽取出的知识图谱实体与关系都会一并清除（被其他文档共同引用的实体会保留）。`,
      )
    )
      return;
    try {
      const result = await deleteDocument(source);
      setSelectedSource(null);
      setChunks([]);
      await refresh();
      const removed = result?.graph;
      if (removed && (removed.entities > 0 || removed.relations > 0)) {
        setNotice({
          type: "success",
          text: `已删除「${source}」，同时清理图谱 ${removed.entities} 个实体、${removed.relations} 条关系`,
        });
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

  const saveDocumentMetadata = async (source: string, patch: { title: string; tags: string[] }) => {
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

  return (
    <section
      className={`domain-workspace rag-workspace${dragging ? " is-dragging" : ""}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void upload(Array.from(event.dataTransfer.files));
      }}
    >
      <input
        ref={fileInput}
        hidden
        type="file"
        multiple
        accept=".pdf,.txt,.md"
        onChange={(event) => {
          void upload(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <header className="domain-header">
        <div>
          <p className="domain-eyebrow">上下文工程 / RAG</p>
          <h1>知识库</h1>
        </div>
        <div className="domain-header-actions">
          <div className="segmented-control rag-view-switch" aria-label="知识库视图">
            <button
              type="button"
              className={view === "documents" ? "is-active" : ""}
              onClick={() => setView("documents")}
            >
              <FileTextOutlined /> 文档
            </button>
            <button
              type="button"
              className={view === "analytics" ? "is-active" : ""}
              onClick={() => setView("analytics")}
            >
              <BarChartOutlined /> 运营分析
            </button>
          </div>
          <span className={`capability-state${stats?.embeddingsEnabled ? " is-on" : ""}`}>
            <span /> 向量检索
          </span>
          <span className={`capability-state${stats?.llmAvailable ? " is-on" : ""}`}>
            <span /> LLM
          </span>
          <button
            className="studio-button secondary"
            type="button"
            onClick={() => {
              setNotice(null);
              if (view === "analytics") void refreshAnalytics();
              else void refresh();
            }}
          >
            <ReloadOutlined /> 刷新
          </button>
          <button
            className="studio-button primary"
            type="button"
            disabled={busy === "upload" || Boolean(separatorError) || semanticUnavailable}
            onClick={() => fileInput.current?.click()}
          >
            <CloudUploadOutlined /> {busy === "upload" ? "入库中..." : "上传文档"}
          </button>
        </div>
      </header>

      {dragging ? (
        <div className="drop-overlay">
          <CloudUploadOutlined />
          <b>释放以导入知识库</b>
          <span>PDF、TXT、Markdown</span>
        </div>
      ) : null}
      {notice ? (
        <div className={`workspace-notice ${notice.type}`} role="status">
          {notice.type === "success" ? <CheckCircleFilled /> : null}
          {notice.text}
        </div>
      ) : null}

      {view === "analytics" ? (
        <RagAnalyticsDashboard overview={analytics} loading={analyticsLoading} />
      ) : (
        <div className="domain-grid">
          <aside className="resource-panel">
            <div className="panel-heading">
              <span>知识来源</span>
              <span className="count-badge">{stats?.sources.length ?? 0}</span>
            </div>
            {busy === "loading" ? <div className="panel-state">正在加载知识库...</div> : null}
            {!busy && stats?.sources.length === 0 ? (
              <div className="panel-state">拖入文档以创建知识来源</div>
            ) : null}
            <div className="resource-list">
              {stats?.sources.map((item) => (
                <button
                  type="button"
                  key={item.source}
                  className={`resource-item${selectedSource === item.source ? " is-active" : ""}`}
                  onClick={() => setSelectedSource(item.source)}
                >
                  <span className="resource-icon rag-source">
                    <FileTextOutlined />
                  </span>
                  <span className="resource-copy">
                    <b title={item.title}>{item.title}</b>
                    <small>
                      v{item.version} · {item.chunks} 个分块
                    </small>
                  </span>
                  <span
                    className="row-action"
                    role="button"
                    tabIndex={0}
                    aria-label={`删除 ${item.source}`}
                    title="删除来源"
                    onClick={(event) => {
                      event.stopPropagation();
                      void removeSource(item.source);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void removeSource(item.source);
                    }}
                  >
                    <DeleteOutlined />
                  </span>
                </button>
              ))}
            </div>
          </aside>

          <div className="rag-preview-panel">
            <div className="rag-query-bar">
              <SearchOutlined />
              <textarea
                rows={2}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void runQuery();
                }}
                placeholder="输入问题，预览召回片段与生成结果"
              />
              <button
                className="studio-button primary"
                type="button"
                disabled={!query.trim() || busy === "query"}
                onClick={() => void runQuery()}
              >
                {busy === "query" ? "检索中..." : "运行检索"}
              </button>
            </div>
            {result ? (
              <QueryPreview
                result={result}
                feedback={feedback[result.queryId]}
                onFeedback={(rating) => void sendFeedback(result.queryId, rating)}
              />
            ) : (
              <ChunkPreview source={selectedSource} chunks={chunks} />
            )}
          </div>

          <aside className="inspector-panel">
            <div className="panel-heading">
              <span>检索设置</span>
              <SettingOutlined />
            </div>
            <div className="inspector-content rag-settings">
              {selectedDocument ? (
                <DocumentMetadataEditor
                  document={selectedDocument}
                  onSave={(patch) => saveDocumentMetadata(selectedDocument.source, patch)}
                />
              ) : null}
              <div className="settings-group">
                <h2>文档切分</h2>
                <p>仅影响随后上传或重新入库的文档。</p>
                <div className="chunk-strategy-control" role="group" aria-label="切分模式">
                  <button
                    type="button"
                    className={settings.chunkStrategy === "fixed" ? "is-active" : ""}
                    onClick={() => setSettings({ ...settings, chunkStrategy: "fixed" })}
                  >
                    <b>固定切分</b>
                    <small>结构优先 · 长度兜底</small>
                  </button>
                  <button
                    type="button"
                    className={settings.chunkStrategy === "semantic" ? "is-active" : ""}
                    disabled={!stats?.embeddingsEnabled}
                    title={stats?.embeddingsEnabled ? "" : "需要配置 Embeddings 模型"}
                    onClick={() => setSettings({ ...settings, chunkStrategy: "semantic" })}
                  >
                    <b>语义切分</b>
                    <small>话题变化处断块</small>
                  </button>
                </div>
                {!stats?.embeddingsEnabled ? (
                  <div className="semantic-capability-note">
                    语义切分需要 Embeddings；当前仍可使用固定切分与 BM25 检索。
                  </div>
                ) : null}
                <NumberField
                  label={settings.chunkStrategy === "semantic" ? "最大分块长度" : "分块长度"}
                  value={settings.chunkSize}
                  min={1}
                  max={4000}
                  step={50}
                  onChange={(chunkSize) => setSettings({ ...settings, chunkSize })}
                />
                <NumberField
                  label="重叠长度"
                  value={settings.chunkOverlap}
                  min={0}
                  max={Math.max(0, settings.chunkSize - 1)}
                  step={10}
                  onChange={(chunkOverlap) => setSettings({ ...settings, chunkOverlap })}
                />
                {settings.chunkStrategy === "semantic" ? (
                  <label className="range-field semantic-threshold-field">
                    <span>
                      语义敏感度 <b>{Math.round(settings.semanticThreshold * 100)}%</b>
                    </span>
                    <input
                      type="range"
                      min={0.5}
                      max={0.95}
                      step={0.05}
                      value={settings.semanticThreshold}
                      onChange={(event) =>
                        setSettings({
                          ...settings,
                          semanticThreshold: Number(event.target.value),
                        })
                      }
                    />
                    <small className="field-help">
                      相邻句段相似度低于阈值时开启新分块；数值越高，切分越细。
                    </small>
                  </label>
                ) : (
                  <label
                    className={`studio-field separator-field${separatorError ? " is-invalid" : ""}`}
                  >
                    <span>
                      分段标识符
                      <small>{settings.separators.length}/20</small>
                    </span>
                    <textarea
                      className="mono-input"
                      rows={7}
                      value={separatorText}
                      aria-invalid={Boolean(separatorError)}
                      onChange={(event) => {
                        const nextText = event.target.value;
                        setSeparatorText(nextText);
                        setSettings({ ...settings, separators: separatorsFromText(nextText) });
                      }}
                    />
                    <small className="field-help">
                      一行一个，按顺序匹配。支持 \n、\t、\s（空格）。
                    </small>
                    {separatorError ? (
                      <small className="field-error">{separatorError}</small>
                    ) : null}
                  </label>
                )}
              </div>
              <div className="settings-group">
                <h2>召回策略</h2>
                <p>混合检索使用向量 kNN 与 BM25，经 RRF 融合排序。</p>
                <label className="range-field">
                  <span>
                    Top-K <b>{settings.topK}</b>
                  </span>
                  <input
                    type="range"
                    min={1}
                    max={10}
                    value={settings.topK}
                    onChange={(event) =>
                      setSettings({ ...settings, topK: Number(event.target.value) })
                    }
                  />
                </label>
                <label className="toggle-field">
                  <span>
                    <b>仅当前文档</b>
                    <small>{selectedSource ? `限定 ${selectedSource}` : "请先选择文档"}</small>
                  </span>
                  <input
                    type="checkbox"
                    disabled={!selectedSource}
                    checked={settings.restrictToSelected}
                    onChange={(event) =>
                      setSettings({ ...settings, restrictToSelected: event.target.checked })
                    }
                  />
                </label>
                <label className="toggle-field">
                  <span>
                    <b>生成回答</b>
                    <small>召回后调用 LLM 生成答案</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={settings.generate}
                    onChange={(event) =>
                      setSettings({ ...settings, generate: event.target.checked })
                    }
                  />
                </label>
              </div>
              <div className="index-summary">
                <DatabaseOutlined />
                <span>
                  <b>{stats?.chunks ?? 0}</b>
                  <small>已索引分块</small>
                </span>
              </div>
            </div>
          </aside>
        </div>
      )}
    </section>
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

function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="studio-field">
      <span>
        {label}
        <small>
          {min}–{max}
        </small>
      </span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Math.max(min, Math.min(max, Number(event.target.value))))}
      />
    </label>
  );
}

function DocumentMetadataEditor({
  document,
  onSave,
}: {
  document: DocumentSource;
  onSave: (patch: { title: string; tags: string[] }) => Promise<void>;
}) {
  const [title, setTitle] = useState(document.title);
  const [tagText, setTagText] = useState(document.tags.join(", "));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setTitle(document.title);
    setTagText(document.tags.join(", "));
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

  return (
    <div className="settings-group document-profile">
      <div className="document-profile-heading">
        <div>
          <h2>资产信息</h2>
          <p>{document.source}</p>
        </div>
        <span>v{document.version}</span>
      </div>
      <label className="studio-field">
        <span>显示标题</span>
        <input value={title} maxLength={160} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label className="studio-field">
        <span>
          标签 <small>{tags.length}/20</small>
        </span>
        <input
          value={tagText}
          placeholder="产品, 生产, FAQ"
          onChange={(event) => setTagText(event.target.value)}
        />
      </label>
      {tags.length > 0 ? (
        <div className="document-tags" aria-label="文档标签">
          {tags.map((tag) => (
            <span key={tag}>
              <TagOutlined /> {tag}
            </span>
          ))}
        </div>
      ) : null}
      <dl className="document-facts">
        <div>
          <dt>类型</dt>
          <dd>{document.mimeType}</dd>
        </div>
        <div>
          <dt>大小</dt>
          <dd>{formatBytes(document.byteSize)}</dd>
        </div>
        <div>
          <dt>切分策略</dt>
          <dd>
            {document.chunkStrategy === "semantic"
              ? `语义 · ${Math.round((document.semanticThreshold ?? 0.75) * 100)}%`
              : `固定 · ${document.chunkSize}/${document.chunkOverlap}`}
          </dd>
        </div>
        <div>
          <dt>更新</dt>
          <dd>{formatDateTime(document.updatedAt)}</dd>
        </div>
      </dl>
      <button
        className="studio-button secondary full-width"
        type="button"
        disabled={invalid || saving}
        onClick={async () => {
          setSaving(true);
          try {
            await onSave({ title: title.trim(), tags });
          } finally {
            setSaving(false);
          }
        }}
      >
        <SaveOutlined /> {saving ? "保存中..." : "保存资产信息"}
      </button>
    </div>
  );
}

function RagAnalyticsDashboard({
  overview,
  loading,
}: {
  overview: AnalyticsOverview | null;
  loading: boolean;
}) {
  if (loading && !overview) return <div className="rag-analytics-state">正在汇总查询数据...</div>;
  if (!overview) return <div className="rag-analytics-state">暂无运营数据</div>;
  const maxQueries = Math.max(1, ...overview.daily.map((day) => day.queries));
  const helpful = overview.totals.helpfulRate;
  return (
    <div className="rag-analytics-dashboard">
      <header className="analytics-heading">
        <div>
          <p>最近 {overview.periodDays} 天</p>
          <h2>知识库服务质量</h2>
        </div>
        <span>{loading ? "更新中" : "实时汇总"}</span>
      </header>

      <div className="analytics-metrics">
        <Metric
          label="查询总量"
          value={String(overview.totals.queries)}
          detail={`${overview.totals.failed} 次失败`}
        />
        <Metric
          label="空召回率"
          value={`${Math.round(overview.totals.noHitRate * 100)}%`}
          detail={`${overview.totals.noHits} 次未命中`}
          tone={overview.totals.noHitRate > 0.25 ? "warning" : "normal"}
        />
        <Metric
          label="平均延迟"
          value={`${overview.totals.averageLatencyMs} ms`}
          detail="含检索与生成"
        />
        <Metric
          label="用户好评"
          value={helpful === null ? "--" : `${Math.round(helpful * 100)}%`}
          detail={`${overview.totals.positiveFeedback + overview.totals.negativeFeedback} 条反馈`}
        />
      </div>

      <div className="analytics-main-grid">
        <section className="analytics-section query-trend">
          <div className="analytics-section-heading">
            <h3>查询趋势</h3>
            <span>柱高为每日查询量</span>
          </div>
          <div className="query-bars">
            {overview.daily.map((day) => (
              <div
                className="query-bar-column"
                key={day.date}
                title={`${day.date}: ${day.queries} 次查询`}
              >
                <span>{day.queries || ""}</span>
                <div className="query-bar-track">
                  <i
                    style={{
                      height: `${Math.max(day.queries > 0 ? 8 : 2, (day.queries / maxQueries) * 100)}%`,
                    }}
                  />
                </div>
                <small>{day.date.slice(5)}</small>
              </div>
            ))}
          </div>
        </section>

        <section className="analytics-section source-ranking">
          <div className="analytics-section-heading">
            <h3>热门知识来源</h3>
            <span>按召回片段数</span>
          </div>
          {overview.topSources.length === 0 ? (
            <div className="analytics-empty">暂无命中来源</div>
          ) : (
            <ol>
              {overview.topSources.map((source, index) => (
                <li key={source.source}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <b title={source.source}>{source.source}</b>
                  <small>{source.hits} hits</small>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <section className="analytics-section recent-queries">
        <div className="analytics-section-heading">
          <h3>最近查询</h3>
          <span>最多展示 20 条</span>
        </div>
        <div className="analytics-table-wrap">
          <table>
            <thead>
              <tr>
                <th>问题</th>
                <th>命中</th>
                <th>延迟</th>
                <th>反馈</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              {overview.recent.map((item) => (
                <tr key={item.id} className={item.error ? "is-error" : ""}>
                  <td title={item.error ?? item.query}>{item.query}</td>
                  <td>{item.error ? "失败" : item.hitCount}</td>
                  <td>{item.latencyMs} ms</td>
                  <td>
                    {item.feedback === "positive"
                      ? "有用"
                      : item.feedback === "negative"
                        ? "无用"
                        : "--"}
                  </td>
                  <td>{formatDateTime(item.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {overview.recent.length === 0 ? (
            <div className="analytics-empty">运行检索后会在这里显示质量数据</div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
  tone = "normal",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "normal" | "warning";
}) {
  return (
    <article className={`analytics-metric${tone === "warning" ? " is-warning" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
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

function ChunkPreview({ source, chunks }: { source: string | null; chunks: ChunkInfo[] }) {
  return (
    <div className="preview-content">
      <div className="preview-heading">
        <div>
          <p>分块预览</p>
          <h2>{source ?? "未选择知识来源"}</h2>
        </div>
        {source ? <span>{chunks.length} chunks</span> : null}
      </div>
      {!source ? (
        <div className="asset-empty">
          <FileTextOutlined />
          <p>从左侧选择文档查看切分结果</p>
        </div>
      ) : null}
      <div className="chunk-preview-list">
        {chunks.map((chunk) => (
          <article className="knowledge-chunk" key={chunk.id}>
            <header>
              <span>#{String(chunk.chunkIndex + 1).padStart(2, "0")}</span>
              <span>{chunk.length} 字符</span>
              <span className={chunk.hasEmbedding ? "vector-on" : "vector-off"}>
                {chunk.hasEmbedding ? "VECTOR" : "BM25"}
              </span>
            </header>
            <p>{chunk.content}</p>
          </article>
        ))}
      </div>
    </div>
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
    <div className="preview-content query-result">
      <div className="preview-heading">
        <div>
          <p>检索预览</p>
          <h2>{result.query}</h2>
        </div>
        <div className="query-result-actions">
          <span>{result.chunks.length} hits</span>
          <button
            type="button"
            className={feedback === "positive" ? "is-active" : ""}
            aria-label="检索结果有用"
            title="有用"
            onClick={() => onFeedback("positive")}
          >
            <LikeOutlined />
          </button>
          <button
            type="button"
            className={feedback === "negative" ? "is-active is-negative" : ""}
            aria-label="检索结果无用"
            title="无用"
            onClick={() => onFeedback("negative")}
          >
            <DislikeOutlined />
          </button>
        </div>
      </div>
      {result.generate ? (
        <section className="generated-answer">
          <span className="answer-label">ANSWER</span>
          {result.answer ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{result.answer}</ReactMarkdown>
          ) : (
            <p>{result.llmAvailable ? "没有足够资料生成回答。" : "LLM 未启用，仅展示检索结果。"}</p>
          )}
        </section>
      ) : null}
      <div className="chunk-preview-list">
        {result.chunks.map((chunk, index) => (
          <article className="knowledge-chunk is-hit" key={chunk.id}>
            <header>
              <span>#{String(index + 1).padStart(2, "0")}</span>
              <span>
                {chunk.source} · 第 {chunk.chunkIndex + 1} 段
              </span>
              <span>{chunk.score.toFixed(4)}</span>
            </header>
            <p>{chunk.content}</p>
          </article>
        ))}
      </div>
    </div>
  );
}
