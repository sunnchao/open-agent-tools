import { useCallback, useEffect, useState } from "react";
import { BarChartOutlined, LoadingOutlined, ReloadOutlined } from "../../lib/icons.js";
import {
  getToolSla,
  type McpService,
  type ServiceSlaStat,
  type SlaWindow,
  type ToolSlaReport,
  type ToolSlaStat,
} from "./api.js";

/** 工具明细行的 6 列布局:工具 / 调用 / 成功率 / 时延 / 错误 Top / 最近失败。 */
const SLA_GRID = {
  gridTemplateColumns: "minmax(150px, 1.1fr) 76px 96px 132px 150px minmax(180px, 1.5fr)",
};

function formatPercent(value: number): string {
  return `${Math.round(value * 1_000) / 10}%`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function rateClass(failed: number): string {
  return failed === 0 ? "status-succeeded" : "status-failed";
}

function ToolSlaRow({ tool }: { tool: ToolSlaStat }) {
  const topError = tool.errors[0];
  return (
    <div className="operations-table-row" style={SLA_GRID}>
      <span>
        <b>{tool.toolName}</b>
        <small>max {tool.maxDurationMs}ms</small>
      </span>
      <span>
        <b>{tool.calls}</b>
        <small>
          {tool.succeeded} 成功 / {tool.failed} 失败
        </small>
      </span>
      <span className={`operation-status ${rateClass(tool.failed)}`}>
        <b>{formatPercent(tool.successRate)}</b>
        <small>{tool.failed === 0 ? "无失败" : `${tool.failed} 次失败`}</small>
      </span>
      <span>
        <b>P95 {tool.p95DurationMs}ms</b>
        <small>P50 {tool.p50DurationMs}ms</small>
      </span>
      <span>
        <b title={topError?.message}>{topError ? topError.code : "窗口内无错误"}</b>
        <small>{topError ? `${topError.message} ×${topError.count}` : "—"}</small>
      </span>
      <span>
        <b title={tool.lastFailure?.message}>
          {tool.lastFailure ? tool.lastFailure.message : "窗口内没有失败"}
        </b>
        <small>
          {tool.lastFailure
            ? `${tool.lastFailure.code} · HTTP ${tool.lastFailure.statusCode} · ${formatTime(
                tool.lastFailure.createdAt,
              )}`
            : "—"}
        </small>
      </span>
    </div>
  );
}

function ServiceSlaSection({ service }: { service: ServiceSlaStat }) {
  return (
    <section>
      <div className="panel-heading">
        <span>/{service.serviceSlug}</span>
        <span className="count-badge">
          {formatPercent(service.successRate)} · P95 {service.p95DurationMs}ms · {service.calls}{" "}
          次调用
        </span>
      </div>
      <div className="operations-table">
        <div className="operations-table-head" style={SLA_GRID}>
          <span>工具</span>
          <span>调用</span>
          <span>成功率</span>
          <span>时延</span>
          <span>错误 Top</span>
          <span>最近一次失败原因</span>
        </div>
        {service.tools.map((tool) => (
          <ToolSlaRow key={tool.toolName} tool={tool} />
        ))}
      </div>
    </section>
  );
}

export function SlaPanel({ services = [] }: { services?: McpService[] }) {
  const [range, setRange] = useState<SlaWindow>("24h");
  const [serviceSlug, setServiceSlug] = useState("");
  const [report, setReport] = useState<ToolSlaReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReport(await getToolSla({ window: range, ...(serviceSlug ? { serviceSlug } : {}) }));
      setError("");
    } catch (reason) {
      setReport(null);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [range, serviceSlug]);

  useEffect(() => void load(), [load]);

  const hasData = report !== null && report.services.length > 0;

  return (
    <div className="mcp-operations-view">
      <div className="operations-toolbar">
        <div>
          <b>工具 SLA</b>
          <span>
            {report
              ? `${range} 窗口 · 共 ${report.totals.calls} 次工具调用 · 成功率 ${formatPercent(
                  report.totals.successRate,
                )}`
              : "聚合 Gateway 工具调用审计事件"}
          </span>
        </div>
        <label className="compact-select">
          <span>窗口</span>
          <select value={range} onChange={(event) => setRange(event.target.value as SlaWindow)}>
            <option value="24h">最近 24 小时</option>
            <option value="7d">最近 7 天</option>
          </select>
        </label>
        <label className="compact-select">
          <span>服务</span>
          <select value={serviceSlug} onChange={(event) => setServiceSlug(event.target.value)}>
            <option value="">全部服务</option>
            {services.map((service) => (
              <option key={service.id} value={service.slug}>
                {service.name} /{service.slug}
              </option>
            ))}
          </select>
        </label>
        <button
          className="icon-command"
          type="button"
          title="刷新"
          aria-label="刷新"
          onClick={() => void load()}
        >
          <ReloadOutlined />
        </button>
      </div>

      {error ? (
        <div className="workspace-notice error" role="status">
          SLA 数据加载失败:{error}
        </div>
      ) : null}

      {loading ? (
        <div className="operations-empty">
          <LoadingOutlined spin />
          <p>正在聚合工具调用审计事件</p>
        </div>
      ) : null}

      {!loading && !hasData ? (
        <div className="operations-empty">
          <BarChartOutlined />
          <p>窗口内没有工具调用记录</p>
          <small>
            只有 Gateway 收到 tools/call 请求后才会产生审计事件;请确认已有客户端携带 API Key
            调用过已发布版本。
          </small>
        </div>
      ) : null}

      {!loading && hasData && report.scan.truncated ? (
        <p className="muted-copy">
          统计仅覆盖最近 {report.scan.limit} 条工具调用审计事件(已截断),更早的调用未纳入本次窗口。
        </p>
      ) : null}

      {!loading && hasData
        ? report.services.map((service) => (
            <ServiceSlaSection key={service.serviceSlug} service={service} />
          ))
        : null}
    </div>
  );
}
