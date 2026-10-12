import { useCallback, useEffect, useState } from "react";
import { AuditOutlined, ReloadOutlined, SearchOutlined } from "../../lib/icons.js";
import {
  fetchQueryAudit,
  fetchQueryAudits,
  type QueryAuditRecord,
  type QueryAuditStatus,
  type QueryAuditSummary,
} from "./api.js";
import { AUDIT_STATUS_LABELS, formatDuration, QueryExecution } from "./QueryExecution.js";

const PAGE_SIZE = 20;

export function QueryAuditView({ sourceId }: { sourceId: string }) {
  const [records, setRecords] = useState<QueryAuditSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState<QueryAuditStatus | "">("");
  const [search, setSearch] = useState("");
  const [keyword, setKeyword] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [record, setRecord] = useState<QueryAuditRecord | null>(null);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [allSources, setAllSources] = useState(false);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void fetchQueryAudits({
      sourceId: allSources ? undefined : sourceId || undefined,
      status: status || undefined,
      search: keyword,
      limit: PAGE_SIZE,
      offset,
    })
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
  }, [sourceId, allSources, status, keyword, offset, revision]);

  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    setRecord(null);
    setDetailError("");
    void fetchQueryAudit(selectedId)
      .then((next) => {
        if (active) setRecord(next);
      })
      .catch((reason: unknown) => {
        if (active) setDetailError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
    };
  }, [selectedId, revision]);

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
        <button className="studio-button secondary" type="submit">
          搜索
        </button>
        <button className="studio-button secondary" type="button" onClick={refresh}>
          <ReloadOutlined /> 刷新
        </button>
        <span className="obs-audit-count">{total} 条记录</span>
      </form>
      {error ? (
        <div className="workspace-notice error" role="alert">
          {error}
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
                {record.error ? <p className="workspace-notice error">{record.error}</p> : null}
                {record.clarifying ? <p>{record.clarifying}</p> : null}
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
