import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AuditOutlined,
  DownloadOutlined,
  ReloadOutlined,
  SearchOutlined,
} from "../../lib/icons.js";
import {
  fetchQueryAuditDetail,
  fetchQueryAudits,
  rerunObservatoryQuery,
  type QueryAuditDetail,
  type QueryAuditSource,
  type QueryAuditRecord,
  type QueryAuditStatus,
  type QueryAuditSummary,
  type QueryEntrypoint,
  type QuerySqlSource,
} from "./api.js";
import { auditExportPath, downloadExport, type ExportFormat } from "./export.js";
import { AUDIT_STATUS_LABELS, formatDuration, QueryExecution } from "./QueryExecution.js";

const PAGE_SIZE = 20;

const ENTRYPOINTS: Array<{ value: QueryEntrypoint; label: string }> = [
  { value: "observatory", label: "Observatory" },
  { value: "rerun", label: "重跑" },
  { value: "chat", label: "对话" },
  { value: "workflow", label: "工作流" },
  { value: "unknown", label: "历史/未知" },
];

const AUDIT_SOURCES: Array<{ value: QueryAuditSource; label: string }> = [
  { value: "generated", label: "生成" },
  { value: "rerun", label: "重跑" },
  { value: "clarification", label: "澄清" },
  { value: "chat", label: "对话" },
  { value: "workflow", label: "工作流" },
];

const SQL_SOURCES: Array<{ value: QuerySqlSource; label: string }> = [
  { value: "generated", label: "模型生成" },
  { value: "original", label: "原样" },
  { value: "edited", label: "人工编辑" },
];

export function QueryAuditView({ sourceId }: { sourceId: string }) {
  const [records, setRecords] = useState<QueryAuditSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState<QueryAuditStatus | "">("");
  const [entrypoint, setEntrypoint] = useState<QueryEntrypoint | "">("");
  const [auditSource, setAuditSource] = useState<QueryAuditSource | "">("");
  const [sqlSource, setSqlSource] = useState<QuerySqlSource | "">("");
  const [actor, setActor] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState("");
  const [keyword, setKeyword] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [record, setRecord] = useState<QueryAuditRecord | null>(null);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [allSources, setAllSources] = useState(false);
  const [detail, setDetail] = useState<QueryAuditDetail | null>(null);
  const [rerunSql, setRerunSql] = useState("");
  const [rerunning, setRerunning] = useState(false);
  const [rerunNotice, setRerunNotice] = useState("");
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [exportError, setExportError] = useState("");

  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  // 列表与导出共用同一份筛选条件,避免「列表看到的」和「导出的」不一致。
  const filters = useMemo(
    () => ({
      sourceId: allSources ? undefined : sourceId || undefined,
      status: status || undefined,
      actor: actor || undefined,
      entrypoint: entrypoint || undefined,
      source: auditSource || undefined,
      sqlSource: sqlSource || undefined,
      from: from ? new Date(from).toISOString() : undefined,
      to: to ? new Date(to).toISOString() : undefined,
      search: keyword,
    }),
    [sourceId, allSources, status, actor, entrypoint, auditSource, sqlSource, from, to, keyword],
  );
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void fetchQueryAudits({ ...filters, limit: PAGE_SIZE, offset })
      .then((next) => {
        if (active) {
          setRecords(next.records);
          setTotal(next.total);
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [filters, offset, revision]);

  const exportAudits = async (format: ExportFormat) => {
    if (exporting) return;
    setExporting(format);
    setExportError("");
    try {
      await downloadExport(auditExportPath(filters, format), `query-audits.${format}`);
    } catch (reason) {
      setExportError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setExporting(null);
    }
  };

  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    setRecord(null);
    setDetail(null);
    setDetailError("");
    void fetchQueryAuditDetail(selectedId)
      .then((next) => {
        if (active) {
          const latest =
            next.children
              .filter((child) => child.status === "succeeded")
              .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))[0] ??
            next.record;
          const latestExecution =
            "executedSql" in latest && typeof latest.executedSql === "string"
              ? latest.executedSql
              : null;
          setDetail(next);
          setRecord(next.record);
          setRerunSql(latestExecution || next.record.executedSql || next.record.generatedSql || "");
          setRerunNotice("");
        }
      })
      .catch((reason: unknown) => {
        if (active) setDetailError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
    };
  }, [selectedId, revision]);

  const rerun = async () => {
    if (!record || !rerunSql.trim() || rerunning) return;
    setRerunning(true);
    setRerunNotice("");
    try {
      const result = await rerunObservatoryQuery(record.id, rerunSql);
      setRerunNotice(
        result.error
          ? result.error
          : `已创建子审计 ${result.auditId?.slice(0, 8) ?? "(未知)"}，执行完成`,
      );
      if (result.auditId) {
        setSelectedId(result.auditId);
      }
      refresh();
    } catch (reason) {
      setRerunNotice(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRerunning(false);
    }
  };

  return (
    <div className="obs-audit-view">
      <form
        className="obs-audit-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          setKeyword(search.trim());
          setOffset(0);
          refresh();
        }}
      >
        <label className="obs-audit-search">
          <SearchOutlined />
          <input
            aria-label="搜索审计日志"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索问题或查询 ID"
          />
        </label>
        <select
          aria-label="审计数据源范围"
          value={allSources ? "all" : "current"}
          onChange={(event) => {
            setAllSources(event.target.value === "all");
            setOffset(0);
            setSelectedId(null);
            setRecord(null);
          }}
        >
          <option value="current">当前数据源</option>
          <option value="all">全部数据源</option>
        </select>
        <select
          aria-label="审计执行状态"
          value={status}
          onChange={(event) => {
            setStatus(event.target.value as QueryAuditStatus | "");
            setOffset(0);
          }}
        >
          <option value="">全部状态</option>
          {Object.entries(AUDIT_STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select
          aria-label="审计入口"
          value={entrypoint}
          onChange={(event) => {
            setEntrypoint(event.target.value as QueryEntrypoint | "");
            setOffset(0);
          }}
        >
          <option value="">全部入口</option>
          {ENTRYPOINTS.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
        <select
          aria-label="审计来源"
          value={auditSource}
          onChange={(event) => {
            setAuditSource(event.target.value as QueryAuditSource | "");
            setOffset(0);
          }}
        >
          <option value="">全部来源</option>
          {AUDIT_SOURCES.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
        <select
          aria-label="SQL 来源"
          value={sqlSource}
          onChange={(event) => {
            setSqlSource(event.target.value as QuerySqlSource | "");
            setOffset(0);
          }}
        >
          <option value="">全部 SQL 来源</option>
          {SQL_SOURCES.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
        <input
          className="obs-audit-filter-input"
          aria-label="审计 actor"
          value={actor}
          onChange={(event) => setActor(event.target.value.trim())}
          placeholder="actor 指纹"
        />
        <label className="obs-audit-time-filter">
          从
          <input
            aria-label="审计开始时间"
            type="datetime-local"
            value={from}
            onChange={(event) => {
              setFrom(event.target.value);
              setOffset(0);
            }}
          />
        </label>
        <label className="obs-audit-time-filter">
          至
          <input
            aria-label="审计结束时间"
            type="datetime-local"
            value={to}
            onChange={(event) => {
              setTo(event.target.value);
              setOffset(0);
            }}
          />
        </label>
        <button className="studio-button secondary" type="submit">
          搜索
        </button>
        <button className="studio-button secondary" type="button" onClick={refresh}>
          <ReloadOutlined /> 刷新
        </button>
        <button
          className="studio-button secondary"
          type="button"
          disabled={exporting !== null}
          onClick={() => void exportAudits("csv")}
        >
          <DownloadOutlined /> {exporting === "csv" ? "导出中..." : "导出 CSV"}
        </button>
        <button
          className="studio-button secondary"
          type="button"
          disabled={exporting !== null}
          onClick={() => void exportAudits("json")}
        >
          <DownloadOutlined /> {exporting === "json" ? "导出中..." : "导出 JSON"}
        </button>
        <span className="obs-audit-count">{total} 条记录</span>
      </form>
      {error ? (
        <div className="workspace-notice error" role="alert">
          {error}
        </div>
      ) : null}
      {exportError ? (
        <div className="workspace-notice error" role="alert">
          导出失败:{exportError}
        </div>
      ) : null}
      <div className="obs-audit-layout">
        <div className="obs-audit-list">
          <div className="obs-table-wrap">
            <table aria-label="问数审计日志">
              <thead>
                <tr>
                  <th>时间 / 查询 ID</th>
                  <th>问题 / 数据源</th>
                  <th>状态</th>
                  <th>链路</th>
                  <th>耗时</th>
                  <th>行数</th>
                </tr>
              </thead>
              <tbody>
                {records.map((item) => (
                  <tr key={item.id} className={selectedId === item.id ? "is-selected" : ""}>
                    <td>
                      <time>{new Date(item.startedAt).toLocaleString()}</time>
                      <small title={item.id}>{item.id.slice(0, 8)}</small>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="obs-audit-question"
                        onClick={() => setSelectedId(item.id)}
                      >
                        {item.question}
                      </button>
                      <small>{item.sourceName ?? item.sourceId ?? "默认数据源"}</small>
                    </td>
                    <td>
                      <span className={`obs-status is-${item.status}`}>
                        {AUDIT_STATUS_LABELS[item.status]}
                      </span>
                    </td>
                    <td>
                      <small>
                        {item.entrypoint} · {item.source} · {item.sqlSource}
                      </small>
                      {item.parentAuditId ? (
                        <button
                          type="button"
                          className="obs-audit-link"
                          onClick={() => setSelectedId(item.parentAuditId)}
                        >
                          父审计 {item.parentAuditId.slice(0, 8)}
                        </button>
                      ) : null}
                    </td>
                    <td>{formatDuration(item.durationMs)}</td>
                    <td>{item.rowCount ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {loading ? (
            <p className="panel-state" role="status">
              正在加载审计日志...
            </p>
          ) : records.length === 0 ? (
            <p className="panel-state">
              <AuditOutlined /> 暂无匹配的查询记录
            </p>
          ) : null}
          <div className="obs-audit-pagination">
            <button
              className="studio-button secondary"
              type="button"
              disabled={loading || offset === 0}
              onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}
            >
              上一页
            </button>
            <span>
              第 {Math.floor(offset / PAGE_SIZE) + 1} / {Math.max(1, Math.ceil(total / PAGE_SIZE))}{" "}
              页
            </span>
            <button
              className="studio-button secondary"
              type="button"
              disabled={loading || offset + PAGE_SIZE >= total}
              onClick={() => setOffset((value) => value + PAGE_SIZE)}
            >
              下一页
            </button>
          </div>
        </div>
        <aside className="obs-audit-detail" aria-label="查询审计详情">
          <div className="panel-heading">
            <span>查询详情</span>
          </div>
          {detailError ? (
            <div className="workspace-notice error" role="alert">
              {detailError}
            </div>
          ) : null}
          {!record ? (
            <p className="panel-state">
              {selectedId && !detailError ? "正在加载详情..." : "选择一条记录查看执行过程"}
            </p>
          ) : (
            <>
              <div className="obs-audit-metadata">
                <strong>{record.question}</strong>
                <span className={`obs-status is-${record.status}`}>
                  {AUDIT_STATUS_LABELS[record.status]}
                </span>
                <dl>
                  <dt>数据源</dt>
                  <dd>{record.sourceName ?? record.sourceId ?? "默认数据源"}</dd>
                  <dt>Actor</dt>
                  <dd title={record.actor}>
                    {record.actor} · {record.actorType === "legacy" ? "历史记录" : "部署 operator"}
                  </dd>
                  <dt>入口 / 来源</dt>
                  <dd>
                    {record.entrypoint} · {record.source} · SQL {record.sqlSource}
                  </dd>
                  <dt>原始问题</dt>
                  <dd>{record.originalQuestion || record.question}</dd>
                  <dt>总耗时</dt>
                  <dd>{formatDuration(record.durationMs)}</dd>
                  <dt>模型</dt>
                  <dd>{record.model ?? "—"}</dd>
                  <dt>Provider</dt>
                  <dd>{record.providerId ?? "—"}</dd>
                  <dt>相关表</dt>
                  <dd>{record.selectedTables.join("、") || "—"}</dd>
                  <dt>开始时间</dt>
                  <dd>{new Date(record.startedAt).toLocaleString()}</dd>
                  <dt>结束时间</dt>
                  <dd>
                    {record.finishedAt ? new Date(record.finishedAt).toLocaleString() : "执行中"}
                  </dd>
                </dl>
                {detail?.parent ? (
                  <p className="obs-audit-lineage">
                    父审计：
                    <button type="button" onClick={() => setSelectedId(detail.parent!.id)}>
                      {detail.parent.id.slice(0, 8)}
                    </button>
                  </p>
                ) : null}
                {detail?.children.length ? (
                  <p className="obs-audit-lineage">
                    子审计：
                    {detail.children.map((child) => (
                      <button key={child.id} type="button" onClick={() => setSelectedId(child.id)}>
                        {child.id.slice(0, 8)}
                      </button>
                    ))}
                  </p>
                ) : null}
                {record.error ? <p className="workspace-notice error">{record.error}</p> : null}
                {record.clarification ? (
                  <div className="obs-clarification-contract">
                    <p>
                      第 {record.clarification.round} 轮 · 待补充：
                      {record.clarification.slots.map((slot) => slot.label).join("、")}
                    </p>
                    <p>{record.clarification.clarifying}</p>
                    {record.clarification.candidates.length ? (
                      <div className="obs-clarify-candidates">
                        {record.clarification.candidates.map((candidate) => (
                          <span key={`${candidate.label}:${candidate.value}`}>
                            {candidate.label}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : record.clarifying ? (
                  <p>{record.clarifying}</p>
                ) : null}
                {record.history.length ? (
                  <details>
                    <summary>查询上下文（{record.history.length} 条）</summary>
                    {record.history.map((turn, index) => (
                      <p key={index}>
                        <b>{turn.role === "user" ? "用户" : "助手"}：</b>
                        {turn.content}
                      </p>
                    ))}
                  </details>
                ) : null}
              </div>
              <QueryExecution steps={record.steps} auditId={record.id} details />
              {record.sql ? (
                <>
                  <div className="panel-heading">
                    <span>SQL</span>
                  </div>
                  <pre className="obs-pre obs-sql">{record.sql}</pre>
                </>
              ) : null}
              <div className="obs-audit-rerun">
                <div className="panel-heading">
                  <span>基于此审计重跑</span>
                </div>
                <textarea
                  aria-label="审计重跑 SQL"
                  value={rerunSql}
                  onChange={(event) => setRerunSql(event.target.value)}
                  placeholder="仅允许单条只读 SELECT，服务端会重新校验"
                  spellCheck={false}
                />
                <div className="obs-rerun-actions">
                  <button
                    className="studio-button secondary"
                    type="button"
                    disabled={
                      rerunning ||
                      Boolean(record.parentAuditId) ||
                      !(record.executedSql ?? record.generatedSql)
                    }
                    onClick={() => setRerunSql(record.executedSql ?? record.generatedSql ?? "")}
                  >
                    恢复执行 SQL
                  </button>
                  <button
                    className="studio-button primary"
                    type="button"
                    disabled={rerunning || Boolean(record.parentAuditId) || !rerunSql.trim()}
                    onClick={() => void rerun()}
                  >
                    {rerunning ? "重跑中..." : "创建子审计并重跑"}
                  </button>
                </div>
                {rerunNotice ? <p className="obs-rerun-notice">{rerunNotice}</p> : null}
              </div>
              {record.rowCount !== null ? (
                <details className="obs-audit-preview">
                  <summary>结果预览 · {record.rowCount} 行</summary>
                  <pre>{JSON.stringify(record.resultPreview, null, 2)}</pre>
                </details>
              ) : null}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
