import { useEffect, useState } from "react";
import { DeleteOutlined, ReloadOutlined, SaveOutlined } from "../../lib/icons.js";
import {
  clearMcpGatewayConfig,
  fetchMcpGatewayConfig,
  saveMcpGatewayConfig,
  type McpGatewayConfig,
} from "./mcpGateway.js";

const sourceLabel: Record<McpGatewayConfig["source"], string> = {
  database: "设置页",
  environment: "环境变量",
  none: "未配置",
};

export function McpGatewaySection() {
  const [config, setConfig] = useState<McpGatewayConfig | null>(null);
  const [gatewayUrl, setGatewayUrl] = useState("http://localhost:4100");
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchMcpGatewayConfig();
      setConfig(next);
      setGatewayUrl(next.gatewayUrl);
      setApiKey("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "MCP Gateway 配置加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const save = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const next = await saveMcpGatewayConfig({
        gatewayUrl,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      setConfig(next);
      setGatewayUrl(next.gatewayUrl);
      setApiKey("");
      setNotice("MCP Gateway 已保存。工作流和对话会立即使用这份配置。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "MCP Gateway 配置保存失败");
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    if (!window.confirm("清除设置页中的 MCP Gateway 配置，并回退到环境变量？")) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const next = await clearMcpGatewayConfig();
      setConfig(next);
      setGatewayUrl(next.gatewayUrl);
      setApiKey("");
      setNotice("已清除设置页配置。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "MCP Gateway 配置清除失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="settings-content">
      {error ? <div className="settings-alert">{error}</div> : null}
      {notice ? <div className="settings-alert">{notice}</div> : null}
      <div className="settings-intro">
        <div>
          <span className="settings-kicker">MCP DATA PLANE</span>
          <h2>Gateway 连接</h2>
        </div>
        <button
          className="studio-button secondary"
          type="button"
          onClick={() => void refresh()}
          disabled={loading || saving}
        >
          <ReloadOutlined spin={loading} /> <span>刷新</span>
        </button>
      </div>
      <form
        className="mcp-gateway-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="studio-field">
          <span>Gateway 地址</span>
          <input
            required
            value={gatewayUrl}
            disabled={loading || saving}
            onChange={(event) => setGatewayUrl(event.target.value)}
            placeholder="http://localhost:4100"
          />
        </label>
        <label className="studio-field">
          <span>
            API Key <small>{config?.apiKeyMasked ? `当前 ${config.apiKeyMasked}` : "必填"}</small>
          </span>
          <input
            type="password"
            autoComplete="new-password"
            value={apiKey}
            disabled={loading || saving}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={config?.source === "database" ? "留空则保留当前 Key" : "mcp.xxx.xxx"}
          />
        </label>
        <p className="mcp-gateway-note">
          当前来源：{config ? sourceLabel[config.source] : "读取中"}。Key 只保存在 Agent
          Server，不会写入工作流节点。
        </p>
        <div className="mcp-gateway-actions">
          <button className="studio-button primary" type="submit" disabled={loading || saving}>
            <SaveOutlined /> <span>{saving ? "保存中" : "保存"}</span>
          </button>
          {config?.source === "database" ? (
            <button
              className="studio-button secondary"
              type="button"
              disabled={saving}
              onClick={() => void clear()}
            >
              <DeleteOutlined /> <span>清除并使用环境变量</span>
            </button>
          ) : null}
        </div>
      </form>
    </main>
  );
}
