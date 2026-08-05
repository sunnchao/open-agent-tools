import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  CheckCircleFilled,
  CloudUploadOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  FileTextOutlined,
  ReloadOutlined,
  SearchOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import {
  deleteDocument,
  listChunks,
  listDocuments,
  queryKnowledge,
  uploadDocuments,
  type ChunkInfo,
  type DocumentStats,
  type QueryResult,
} from "./api.js";

interface RagSettings {
  chunkSize: number;
  chunkOverlap: number;
  separators: string[];
  topK: number;
  generate: boolean;
}

const defaultSeparators = ["\n\n", "\n", "。", "！", "？", ". ", " "];

const defaultSettings: RagSettings = {
  chunkSize: 1024,
  chunkOverlap: 50,
  separators: defaultSeparators,
  topK: 5,
  generate: true,
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
          separators: next.separators ?? current.separators,
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

  useEffect(() => void refresh(), [refresh]);

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

  const separatorError = validateSeparators(settings.separators);

  const upload = async (files: File[]) => {
    if (files.length === 0) return;
    if (separatorError) {
      setNotice({ type: "error", text: separatorError });
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
    if (!window.confirm(`确认删除知识来源“${source}”及其全部分块？`)) return;
    try {
      await deleteDocument(source);
      setSelectedSource(null);
      setChunks([]);
      await refresh();
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
        }),
      );
    } catch (reason) {
      setNotice({ type: "error", text: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      setBusy(null);
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
              void refresh();
            }}
          >
            <ReloadOutlined /> 刷新
          </button>
          <button
            className="studio-button primary"
            type="button"
            disabled={busy === "upload" || Boolean(separatorError)}
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
                  <b title={item.source}>{item.source}</b>
                  <small>{item.chunks} 个分块</small>
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
            <QueryPreview result={result} />
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
            <div className="settings-group">
              <h2>文档切分</h2>
              <p>仅影响随后上传或重新入库的文档。</p>
              <NumberField
                label="分块长度"
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
                {separatorError ? <small className="field-error">{separatorError}</small> : null}
              </label>
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
                  <b>生成回答</b>
                  <small>召回后调用 LLM 生成答案</small>
                </span>
                <input
                  type="checkbox"
                  checked={settings.generate}
                  onChange={(event) => setSettings({ ...settings, generate: event.target.checked })}
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

function QueryPreview({ result }: { result: QueryResult }) {
  return (
    <div className="preview-content query-result">
      <div className="preview-heading">
        <div>
          <p>检索预览</p>
          <h2>{result.query}</h2>
        </div>
        <span>{result.chunks.length} hits</span>
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
