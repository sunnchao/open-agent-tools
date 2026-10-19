import { useCallback, useEffect, useState } from "react";
import {
  CloseCircleFilled,
  CheckCircleFilled,
  DeleteOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
} from "../../lib/icons.js";
import {
  createReport,
  deleteReport,
  listReports,
  listReportRuns,
  listSchemaSources,
  runReportNow,
  updateReport,
  type ReportDraft,
  type ReportRun,
  type ScheduledReport,
  type SchemaSourceOption,
} from "./api.js";
import {
  REPORT_STATUS_LABELS,
  WEEKDAY_LABELS,
  describeSchedule,
  formatCellValue,
  formatDateTime,
  formatDuration,
  isValidTimeOfDay,
} from "./schedule.js";
import "./reports.css";

interface Notice {
  type: "success" | "error";
  text: string;
}

function emptyDraft(): ReportDraft {
  return {
    name: "",
    question: "",
    sourceId: null,
    frequency: "daily",
    time: "09:00",
    weekday: 1,
    enabled: true,
  };
}

function draftFromReport(report: ScheduledReport): ReportDraft {
  return {
    name: report.name,
    question: report.question,
    sourceId: report.sourceId,
    frequency: report.schedule.frequency,
    time: report.schedule.time,
    weekday: report.schedule.weekday ?? 1,
    enabled: report.enabled,
  };
}

export function ReportsWorkspace() {
  const [reports, setReports] = useState<ScheduledReport[]>([]);
  const [sources, setSources] = useState<SchemaSourceOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ReportDraft | null>(null);
  const [runs, setRuns] = useState<ReportRun[]>([]);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "run" | "delete" | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const loadRuns = useCallback(async (reportId: string) => {
    const body = await listReportRuns(reportId, 20);
    setRuns(body.runs);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [list, schemaSources] = await Promise.all([listReports(), listSchemaSources()]);
      setReports(list.reports);
      setSources(schemaSources);
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "加载失败" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const select = (report: ScheduledReport) => {
    setSelectedId(report.id);
    setDraft(draftFromReport(report));
    setOpenRunId(null);
    void loadRuns(report.id).catch(() => setRuns([]));
  };

  const startNew = () => {
    setSelectedId(null);
    setDraft(emptyDraft());
    setRuns([]);
    setOpenRunId(null);
    setNotice(null);
  };

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim() || !draft.question.trim()) {
      setNotice({ type: "error", text: "名称与问题都不能为空" });
      return;
    }
    if (!isValidTimeOfDay(draft.time)) {
      setNotice({ type: "error", text: "时间必须是 HH:MM(24 小时制)" });
      return;
    }
    setBusy("save");
    setNotice(null);
    try {
      const saved = selectedId
        ? (await updateReport(selectedId, draft)).report
        : (await createReport(draft)).report;
      await refresh();
      setSelectedId(saved.id);
      setDraft(draftFromReport(saved));
      await loadRuns(saved.id);
      setNotice({ type: "success", text: selectedId ? "报表已更新" : "报表已创建" });
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "保存失败" });
    } finally {
      setBusy(null);
    }
  };

  const runNow = async () => {
    if (!selectedId) return;
    setBusy("run");
    setNotice(null);
    try {
      const { run } = await runReportNow(selectedId);
      await Promise.all([refresh(), loadRuns(selectedId)]);
      setOpenRunId(run.id);
      setNotice({
        type: run.status === "succeeded" ? "success" : "error",
        text:
          run.status === "succeeded"
            ? `已运行,返回 ${run.rowCount ?? 0} 行`
            : `运行未成功:${run.error ?? run.status}`,
      });
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "运行失败" });
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!selectedId) return;
    if (!window.confirm("删除这个定时报表?运行历史会一并清理。")) return;
    setBusy("delete");
    setNotice(null);
    try {
      await deleteReport(selectedId);
      startNew();
      await refresh();
      setNotice({ type: "success", text: "报表已删除" });
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "删除失败" });
    } finally {
      setBusy(null);
    }
  };

  const openRun = runs.find((run) => run.id === openRunId) ?? null;
  const nextRunHint =
    draft && draft.enabled
      ? isValidTimeOfDay(draft.time)
        ? `下次运行:${describeSchedule({
            frequency: draft.frequency,
            time: draft.time,
            weekday: draft.weekday,
          })}`
        : "请先填写合法的时间点"
      : "已停用,不会自动执行";

  return (
    <section className="domain-workspace reports-workspace">
      <header className="domain-header">
        <div>
          <p className="domain-eyebrow">智能问数 / 定时报表</p>
          <h1>定时报表</h1>
        </div>
        <div className="domain-header-actions">
          <span className={`capability-state${reports.some((item) => item.enabled) ? " is-on" : ""}`}>
            <span /> {reports.filter((item) => item.enabled).length} 个启用
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
          <button className="studio-button primary" type="button" onClick={startNew}>
            <PlusOutlined /> 新建报表
          </button>
        </div>
      </header>

      {notice ? (
        <div className={`workspace-notice ${notice.type}`} role="status">
          {notice.type === "success" ? <CheckCircleFilled /> : <CloseCircleFilled />}
          {notice.text}
        </div>
      ) : null}

      <div className="domain-grid reports-grid">
        <aside className="resource-panel">
          <div className="panel-heading">
            <span>报表清单</span>
            <span className="count-badge">{reports.length}</span>
          </div>
          {loading ? <div className="panel-state">正在加载报表...</div> : null}
          {!loading && reports.length === 0 ? (
            <div className="panel-state">还没有定时报表,点「新建报表」保存一次问数</div>
          ) : null}
          <div className="resource-list">
            {reports.map((report) => (
              <button
                type="button"
                key={report.id}
                className={`resource-item reports-item${
                  selectedId === report.id ? " is-active" : ""
                }`}
                onClick={() => select(report)}
              >
                <span
                  className={`reports-dot is-${report.enabled ? "enabled" : "paused"}`}
                  aria-hidden="true"
                />
                <span className="resource-copy">
                  <b title={report.name}>{report.name}</b>
                  <small>
                    {describeSchedule(report.schedule)} ·{" "}
                    {report.enabled
                      ? `下次 ${formatDateTime(report.nextRunAt)}`
                      : "已停用"}
                  </small>
                </span>
              </button>
            ))}
          </div>
        </aside>

        <div className="reports-detail">
          {draft ? (
            <form
              className="settings-group reports-form"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <div className="reports-form-heading">
                <div>
                  <h2>{selectedId ? "编辑报表" : "新建报表"}</h2>
                  <p>{selectedId ? `ID ${selectedId.slice(0, 8)}` : "保存后开始按周期自动执行"}</p>
                </div>
                <span className={`reports-status is-${selectedId ? "succeeded" : "running"}`}>
                  {selectedId ? "已保存" : "未保存"}
                </span>
              </div>

              <label className="studio-field">
                <span>
                  名称 <small>{draft.name.length}/120</small>
                </span>
                <input
                  value={draft.name}
                  maxLength={120}
                  placeholder="例如:每日活跃用户"
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </label>

              <label className="studio-field">
                <span>
                  自然语言问题 <small>{draft.question.length}/2000</small>
                </span>
                <textarea
                  rows={3}
                  value={draft.question}
                  maxLength={2000}
                  placeholder="例如:昨天的活跃用户有多少?"
                  onChange={(event) => setDraft({ ...draft, question: event.target.value })}
                />
              </label>

              <label className="studio-field">
                <span>数据源</span>
                <select
                  value={draft.sourceId ?? ""}
                  onChange={(event) =>
                    setDraft({ ...draft, sourceId: event.target.value || null })
                  }
                >
                  <option value="">默认数据源</option>
                  {sources.map((source) => (
                    <option key={source.id} value={source.id}>
                      {source.name}
                      {source.isDefault ? "(默认)" : ""}
                    </option>
                  ))}
                </select>
              </label>

              <div className="reports-schedule">
                <label className="studio-field">
                  <span>周期</span>
                  <select
                    value={draft.frequency}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        frequency: event.target.value === "weekly" ? "weekly" : "daily",
                      })
                    }
                  >
                    <option value="daily">每天</option>
                    <option value="weekly">每周</option>
                  </select>
                </label>
                <label className="studio-field">
                  <span>时间</span>
                  <input
                    type="time"
                    value={draft.time}
                    onChange={(event) => setDraft({ ...draft, time: event.target.value })}
                  />
                </label>
                {draft.frequency === "weekly" ? (
                  <label className="studio-field">
                    <span>星期</span>
                    <select
                      value={String(draft.weekday)}
                      onChange={(event) =>
                        setDraft({ ...draft, weekday: Number(event.target.value) })
                      }
                    >
                      {WEEKDAY_LABELS.map((label, index) => (
                        <option key={label} value={String(index)}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <label className="reports-toggle">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                  />
                  <span>启用自动执行</span>
                </label>
              </div>

              <p className="reports-hint">{nextRunHint}</p>

              <div className="reports-actions">
                <button className="studio-button primary" type="submit" disabled={busy !== null}>
                  <SaveOutlined /> {busy === "save" ? "保存中..." : "保存"}
                </button>
                {selectedId ? (
                  <button
                    className="studio-button secondary"
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void runNow()}
                  >
                    <PlayCircleOutlined /> {busy === "run" ? "运行中..." : "立即运行一次"}
                  </button>
                ) : null}
                {selectedId ? (
                  <button
                    className="studio-button secondary reports-delete"
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void remove()}
                  >
                    <DeleteOutlined /> 删除
                  </button>
                ) : null}
              </div>
            </form>
          ) : (
            <div className="settings-group reports-empty">
              <h2>选择一个报表</h2>
              <p>左侧点选报表查看运行历史,或新建一个把问数变成周期报表。</p>
            </div>
          )}

          {selectedId ? (
            <div className="settings-group reports-history">
              <div className="panel-heading">
                <span>运行历史</span>
                <span className="count-badge">{runs.length}</span>
              </div>
              {runs.length === 0 ? <div className="panel-state">还没有运行记录</div> : null}
              {runs.length > 0 ? (
                <>
                  <div className="operations-table-head reports-runs-head">
                    <span>开始时间</span>
                    <span>触发</span>
                    <span>状态</span>
                    <span>耗时</span>
                    <span>行数</span>
                    <span />
                  </div>
                  {runs.map((run) => (
                    <div className="operations-table-row reports-runs-row" key={run.id}>
                      <time dateTime={run.startedAt}>{formatDateTime(run.startedAt)}</time>
                      <span>{run.trigger === "manual" ? "手动" : "定时"}</span>
                      <span className={`reports-status is-${run.status}`}>
                        {REPORT_STATUS_LABELS[run.status]}
                      </span>
                      <span>{formatDuration(run.durationMs)}</span>
                      <span>{run.rowCount ?? "—"}</span>
                      <button
                        className="studio-button compact secondary"
                        type="button"
                        onClick={() => setOpenRunId(openRunId === run.id ? null : run.id)}
                      >
                        {openRunId === run.id ? "收起" : "查看"}
                      </button>
                    </div>
                  ))}
                </>
              ) : null}

              {openRun ? (
                <div className="reports-run-detail">
                  {openRun.error ? <p className="reports-run-error">{openRun.error}</p> : null}
                  {openRun.sql ? (
                    <pre className="studio-code reports-run-sql">{openRun.sql}</pre>
                  ) : null}
                  {openRun.checks.length > 0 ? (
                    <ul className="reports-checks">
                      {openRun.checks.map((check) => (
                        <li key={`${check.code}-${check.message}`} className={`is-${check.level}`}>
                          {check.message}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {openRun.columns.length > 0 ? (
                    <div className="reports-preview">
                      <table>
                        <thead>
                          <tr>
                            {openRun.columns.map((column) => (
                              <th key={column}>{column}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {openRun.preview.map((row, index) => (
                            <tr key={index}>
                              {openRun.columns.map((column) => (
                                <td key={column}>{formatCellValue(row[column])}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {openRun.truncated ? (
                        <p className="reports-hint">
                          结果已截断,仅保留前 {openRun.preview.length} 行快照
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <p className="panel-state">本次运行没有返回数据</p>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
