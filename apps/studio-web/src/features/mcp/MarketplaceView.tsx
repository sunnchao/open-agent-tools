import { useCallback, useEffect, useMemo, useState } from "react";
import { Input } from "antd";
import {
  ApiOutlined,
  CheckCircleFilled,
  KeyOutlined,
  LoadingOutlined,
  ReloadOutlined,
  SearchOutlined,
  SendOutlined,
  TagOutlined,
  ToolOutlined,
} from "../../lib/icons.js";
import {
  listClients,
  listGrants,
  listMarketplaceServices,
  upsertGrant,
  type ApiClientRecord,
  type ClientGrantRecord,
  type MarketplaceService,
  type McpScope,
} from "./api.js";
import { callGatewayTool } from "./gateway.js";

function messageFrom(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function toolCountLabel(service: MarketplaceService): string {
  return service.toolsUnknown ? "Tools 未知" : `${service.toolCount ?? 0} Tools`;
}

export function MarketplaceView() {
  const [services, setServices] = useState<MarketplaceService[]>([]);
  const [clients, setClients] = useState<ApiClientRecord[]>([]);
  const [selectedClientId, setSelectedClientId] = useState<string>("");
  const [grants, setGrants] = useState<ClientGrantRecord[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [trialService, setTrialService] = useState<MarketplaceService | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [toolName, setToolName] = useState("");
  const [trialArguments, setTrialArguments] = useState("{}");
  const [trialResult, setTrialResult] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [nextServices, nextClients] = await Promise.all([
        listMarketplaceServices(),
        listClients(),
      ]);
      setServices(nextServices);
      setClients(nextClients);
      setSelectedClientId((current) =>
        nextClients.some((client) => client.id === current) ? current : (nextClients[0]?.id ?? ""),
      );
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => void load(), [load]);

  useEffect(() => {
    if (!selectedClientId) {
      setGrants([]);
      return;
    }
    let cancelled = false;
    listGrants(selectedClientId)
      .then((next) => {
        if (!cancelled) setGrants(next);
      })
      .catch((reason) => {
        if (!cancelled) setError(messageFrom(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedClientId]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return services;
    return services.filter((service) => {
      const haystack = [
        service.name,
        service.slug,
        ...service.tools.map((tool) => `${tool.name} ${tool.description ?? ""}`),
        ...service.prompts.map((prompt) => `${prompt.name} ${prompt.title ?? ""}`),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [search, services]);

  const subscribe = async (service: MarketplaceService) => {
    if (!selectedClientId) return;
    setBusy(service.id);
    setError("");
    setNotice("");
    try {
      const scopes: McpScope[] = ["mcp:connect"];
      if (service.toolsUnknown || (service.toolCount ?? 0) > 0) {
        scopes.push("tools:list", "tools:call");
      }
      if (service.promptCount > 0) scopes.push("prompts:list", "prompts:get");
      await upsertGrant(selectedClientId, service.id, {
        scopes,
        toolNames: null,
        promptNames: null,
      });
      setGrants(await listGrants(selectedClientId));
      setNotice(`已为客户端订阅 ${service.name}`);
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setBusy(null);
    }
  };

  const openTrial = (service: MarketplaceService) => {
    setTrialService(service);
    setToolName(service.tools[0]?.name ?? "");
    setTrialArguments("{}");
    setTrialResult("");
    setError("");
  };

  const runTrial = async () => {
    if (!trialService) return;
    setBusy("trial");
    setError("");
    setTrialResult("");
    try {
      const args = JSON.parse(trialArguments) as unknown;
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        throw new Error("试用参数必须是 JSON 对象");
      }
      const result = await callGatewayTool({
        serviceSlug: trialService.slug,
        apiKey,
        toolName,
        arguments: args as Record<string, unknown>,
      });
      setTrialResult(JSON.stringify(result, null, 2));
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mcp-operations-view marketplace-view">
      <div className="operations-toolbar marketplace-toolbar">
        <div>
          <b>工具市场</b>
          <span>{services.length} 个已发布服务</span>
        </div>
        <label className="compact-select">
          <span>订阅客户端</span>
          <select
            value={selectedClientId}
            onChange={(event) => setSelectedClientId(event.target.value)}
          >
            <option value="">选择客户端</option>
            {clients.map((client) => (
              <option value={client.id} key={client.id}>
                {client.name}
              </option>
            ))}
          </select>
        </label>
        <label className="studio-search marketplace-search">
          <SearchOutlined />
          <Input
            value={search}
            autoComplete="off"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索服务、Tool 或 Prompt"
          />
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
      {error ? <div className="workspace-notice error">{error}</div> : null}
      {notice ? <div className="workspace-notice success">{notice}</div> : null}
      {loading ? (
        <div className="operations-empty">
          <LoadingOutlined spin />
          <p>正在读取已发布服务</p>
        </div>
      ) : null}
      {!loading && visible.length === 0 ? (
        <div className="operations-empty">
          <SearchOutlined />
          <p>没有匹配的服务</p>
        </div>
      ) : null}
      <div className="marketplace-grid">
        {visible.map((service) => {
          const subscribed = grants.some((grant) => grant.serviceId === service.id);
          return (
            <article className="marketplace-card" key={service.id}>
              <header>
                <span className="marketplace-card__icon">
                  <ApiOutlined />
                </span>
                <div>
                  <b>{service.name}</b>
                  <small>
                    /{service.slug} · v{service.versionNumber}
                  </small>
                </div>
                <span className="marketplace-card__type">
                  {service.type === "REMOTE_MCP" ? "REMOTE" : "MANAGED"}
                </span>
              </header>
              <div className="marketplace-card__meta">
                <span>
                  <ToolOutlined /> {toolCountLabel(service)}
                </span>
                <span>
                  <TagOutlined /> {service.promptCount} Prompts
                </span>
              </div>
              {service.tools.length > 0 ? (
                <div className="marketplace-card__tools">
                  {service.tools.slice(0, 4).map((tool) => (
                    <span key={tool.name}>{tool.name}</span>
                  ))}
                  {service.tools.length > 4 ? <small>+{service.tools.length - 4}</small> : null}
                </div>
              ) : (
                <p className="marketplace-card__unknown">
                  {service.toolsUnknown
                    ? "Remote MCP 的 Tool 数量需连接上游后才知道，当前不展示为 0。"
                    : "该服务没有 Tool。"}
                </p>
              )}
              <footer>
                <button
                  className="studio-button secondary compact"
                  type="button"
                  onClick={() => openTrial(service)}
                >
                  <SendOutlined /> 试用
                </button>
                <button
                  className="studio-button primary compact"
                  type="button"
                  disabled={!selectedClientId || busy === service.id || subscribed}
                  onClick={() => void subscribe(service)}
                >
                  {busy === service.id ? (
                    <LoadingOutlined spin />
                  ) : subscribed ? (
                    <CheckCircleFilled />
                  ) : (
                    <KeyOutlined />
                  )}
                  {subscribed ? "已订阅" : "一键订阅"}
                </button>
              </footer>
            </article>
          );
        })}
      </div>
      {trialService ? (
        <div
          className="studio-dialog-backdrop"
          role="presentation"
          onMouseDown={() => setTrialService(null)}
        >
          <section
            className="studio-dialog operations-dialog marketplace-trial"
            role="dialog"
            aria-modal="true"
            aria-label={`试用 ${trialService.name}`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <h2>试用 {trialService.name}</h2>
              <button type="button" aria-label="关闭" onClick={() => setTrialService(null)}>
                ×
              </button>
            </header>
            <div className="dialog-form">
              <p className="muted-copy">
                临时 Key 只保存在当前页面内存，不会写入本地存储或服务端 usage 记录之外的字段。
              </p>
              <label className="studio-field">
                <span>
                  Gateway API Key <small>临时</small>
                </span>
                <Input.Password
                  value={apiKey}
                  autoComplete="off"
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="mcp_..."
                />
              </label>
              <label className="studio-field">
                <span>Tool</span>
                {trialService.toolsUnknown ? (
                  <input
                    value={toolName}
                    onChange={(event) => setToolName(event.target.value)}
                    placeholder="输入 Remote MCP Tool 名"
                  />
                ) : (
                  <select value={toolName} onChange={(event) => setToolName(event.target.value)}>
                    {trialService.tools.map((tool) => (
                      <option key={tool.name} value={tool.name}>
                        {tool.name}
                      </option>
                    ))}
                  </select>
                )}
              </label>
              <label className="studio-field">
                <span>参数 JSON</span>
                <textarea
                  value={trialArguments}
                  onChange={(event) => setTrialArguments(event.target.value)}
                  rows={5}
                />
              </label>
              <button
                className="studio-button primary full-width"
                type="button"
                disabled={busy === "trial" || !apiKey.trim() || !toolName.trim()}
                onClick={() => void runTrial()}
              >
                {busy === "trial" ? <LoadingOutlined spin /> : <SendOutlined />} 调用 Tool
              </button>
              {trialResult ? <pre className="studio-code">{trialResult}</pre> : null}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
