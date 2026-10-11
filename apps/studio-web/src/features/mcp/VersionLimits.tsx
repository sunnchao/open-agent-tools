import { useState, type FormEvent } from "react";
import { CheckCircleFilled, EditOutlined, LoadingOutlined } from "../../lib/icons.js";
import {
  McpApiError,
  updateVersionLimits,
  type McpExecutionLimits,
  type McpVersion,
} from "./api.js";

export function VersionLimits({
  serviceId,
  version,
  onRefresh,
}: {
  serviceId: string;
  version: McpVersion;
  onRefresh: (versionId?: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState<{
    limits: McpExecutionLimits;
    revision: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const editable = ["DRAFT", "FAILED", "READY"].includes(version.status);
  const limits = version.limits;

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editing || !editable || busy) return;
    const data = new FormData(event.currentTarget);
    const next: McpExecutionLimits = {
      timeoutMs: Number(data.get("timeoutMs")),
      memoryMb: Number(data.get("memoryMb")),
      cpuMillis: Number(data.get("cpuMillis")),
      network: data.get("network") as McpExecutionLimits["network"],
    };
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await updateVersionLimits(serviceId, version.id, editing.revision, next);
      await onRefresh(version.id);
      setEditing(null);
      setNotice("运行限制已保存");
    } catch (reason) {
      if (reason instanceof McpApiError && reason.code === "CONFLICT") {
        await onRefresh(version.id).catch(() => undefined);
        setEditing(null);
        setError("版本已更新，请重新编辑运行限制。");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mcp-limits-panel" aria-label="运行限制">
      <header className="mcp-limits-heading">
        <div>
          <h2>运行限制</h2>
          <p>应用于当前版本的所有 Tool</p>
        </div>
        {limits && editable && !editing ? (
          <button
            type="button"
            className="studio-button secondary compact"
            onClick={() => {
              setEditing({ limits: { ...limits }, revision: version.revision });
              setError("");
              setNotice("");
            }}
          >
            <EditOutlined /> 编辑限制
          </button>
        ) : null}
      </header>
      {!limits ? (
        <p className="mcp-limits-help">
          {version.status === "VALIDATING"
            ? "代码包检查完成后，将显示 mcp.json 中的运行限制。"
            : version.tools.length === 0
              ? "上传 Tool 代码包后，可在这里查看和调整运行限制。"
              : "当前版本尚未配置运行限制。"}
        </p>
      ) : editing ? (
        <form onSubmit={(event) => void save(event)}>
          <fieldset className="mcp-limits-fields" disabled={busy || !editable}>
            <label className="studio-field">
              <span>
                超时 <small>ms</small>
              </span>
              <input
                name="timeoutMs"
                type="number"
                defaultValue={editing.limits.timeoutMs}
                min={1}
                max={120_000}
                step={1}
                required
              />
              <small className="field-help">1–120,000 ms</small>
            </label>
            <label className="studio-field">
              <span>
                内存 <small>MiB</small>
              </span>
              <input
                name="memoryMb"
                type="number"
                defaultValue={editing.limits.memoryMb}
                min={32}
                max={4_096}
                step={1}
                required
              />
              <small className="field-help">32–4,096 MiB</small>
            </label>
            <label className="studio-field">
              <span>
                CPU <small>millicores</small>
              </span>
              <input
                name="cpuMillis"
                type="number"
                defaultValue={editing.limits.cpuMillis}
                min={10}
                max={8_000}
                step={1}
                required
              />
              <small className="field-help">1,000 millicores = 1 核</small>
            </label>
            <label className="studio-field">
              <span>
                网络 <small>network</small>
              </span>
              <select name="network" defaultValue={editing.limits.network}>
                <option value="none">none · 禁止联网</option>
                <option value="bridge">bridge · 允许联网</option>
              </select>
              <small className="field-help">bridge 允许容器访问外部网络。</small>
            </label>
          </fieldset>
          <div className="mcp-limits-actions">
            <button
              type="button"
              className="studio-button secondary compact"
              disabled={busy}
              onClick={() => {
                setEditing(null);
                setError("");
              }}
            >
              取消
            </button>
            <button
              type="submit"
              className="studio-button primary compact"
              disabled={busy || !editable}
            >
              {busy ? <LoadingOutlined spin /> : <CheckCircleFilled />} 保存限制
            </button>
          </div>
        </form>
      ) : (
        <dl className="mcp-limits-summary">
          <div>
            <dt>超时</dt>
            <dd>
              {limits.timeoutMs.toLocaleString()} <span>ms</span>
            </dd>
          </div>
          <div>
            <dt>内存</dt>
            <dd>
              {limits.memoryMb.toLocaleString()} <span>MiB</span>
            </dd>
          </div>
          <div>
            <dt>CPU</dt>
            <dd>
              {limits.cpuMillis.toLocaleString()} <span>millicores</span>
            </dd>
          </div>
          <div>
            <dt>网络</dt>
            <dd>
              {limits.network} <span>{limits.network === "bridge" ? "允许联网" : "禁止联网"}</span>
            </dd>
          </div>
        </dl>
      )}
      {limits && !editable ? (
        <p className="mcp-limits-help">
          {version.status === "VALIDATING" || version.status === "BUILDING"
            ? "检查或构建完成后可修改运行限制。"
            : "已发布版本只读，创建草稿后可修改。"}
        </p>
      ) : null}
      {notice ? (
        <p className="field-message success" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="field-message error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
