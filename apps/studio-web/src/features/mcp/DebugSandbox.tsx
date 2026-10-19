import { useCallback, useEffect, useMemo, useState } from "react";
import { Input } from "antd";
import {
  CodeOutlined,
  ExperimentOutlined,
  FileTextOutlined,
  KeyOutlined,
  LoadingOutlined,
  SendOutlined,
  UndoOutlined,
} from "../../lib/icons.js";
import {
  listVersions,
  previewPrompt,
  type McpPrompt,
  type McpService,
  type McpTool,
  type McpVersion,
} from "./api.js";

/**
 * 在线调试沙箱的纯函数层:参数解析/校验、JSON-RPC 请求体构造、Gateway 发送。
 * 组件只负责编排;这些函数可以在单测中直接断言。
 */

export interface JsonRpcToolCall {
  jsonrpc: "2.0";
  id: number;
  method: "tools/call";
  params: { name: string; arguments: Record<string, unknown> };
}

export type ParsedArguments =
  { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 解析参数 JSON;空输入视为空参数对象。 */
export function parseArgumentsJson(text: string): ParsedArguments {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (reason) {
    return {
      ok: false,
      error: `JSON 解析失败:${reason instanceof Error ? reason.message : String(reason)}`,
    };
  }
  if (!isPlainObject(parsed)) return { ok: false, error: "参数必须是 JSON 对象" };
  return { ok: true, value: parsed };
}

function typeMismatch(name: string, expected: string, value: unknown): string | null {
  switch (expected) {
    case "string":
      return typeof value === "string" ? null : `${name} 必须是字符串`;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? null : `${name} 必须是数字`;
    case "integer":
      return typeof value === "number" && Number.isInteger(value) ? null : `${name} 必须是整数`;
    case "boolean":
      return typeof value === "boolean" ? null : `${name} 必须是布尔值`;
    case "array":
      return Array.isArray(value) ? null : `${name} 必须是数组`;
    case "object":
      return isPlainObject(value) ? null : `${name} 必须是对象`;
    case "null":
      return value === null ? null : `${name} 必须是 null`;
    default:
      return null;
  }
}

/**
 * 对声明了 inputSchema 的 Tool 做基础校验:
 * 顶层对象结构、required、已声明属性的 type/enum、additionalProperties=false。
 */
export function validateToolArguments(
  schema: Record<string, unknown> | null | undefined,
  value: unknown,
): string[] {
  if (!isPlainObject(value)) return ["参数必须是 JSON 对象"];
  const source = isPlainObject(schema) ? schema : {};
  const errors: string[] = [];
  const declaredType = typeof source.type === "string" ? source.type : "object";
  if (declaredType !== "object") {
    errors.push(`该 Tool 的 inputSchema 顶层类型为 ${declaredType},沙箱仅支持对象参数`);
  }

  const required = Array.isArray(source.required)
    ? source.required.filter((name): name is string => typeof name === "string")
    : [];
  for (const name of required) {
    if (!(name in value) || value[name] === undefined) errors.push(`缺少必填参数:${name}`);
  }

  const properties = isPlainObject(source.properties) ? source.properties : {};
  for (const [name, rawProperty] of Object.entries(properties)) {
    if (!(name in value) || value[name] === undefined) continue;
    const property = isPlainObject(rawProperty) ? rawProperty : {};
    const declared = typeof property.type === "string" ? property.type : undefined;
    if (declared) {
      const mismatch = typeMismatch(name, declared, value[name]);
      if (mismatch) errors.push(mismatch);
    }
    const allowed = Array.isArray(property.enum) ? property.enum : null;
    if (allowed && !allowed.some((candidate) => candidate === value[name])) {
      errors.push(
        `${name} 必须是以下之一:${allowed.map((item) => JSON.stringify(item)).join(", ")}`,
      );
    }
  }

  if (source.additionalProperties === false) {
    for (const name of Object.keys(value)) {
      if (!(name in properties)) errors.push(`未声明的参数:${name}`);
    }
  }

  return errors;
}

/** 构造将要发送的 JSON-RPC `tools/call` 请求体。 */
export function buildToolCallRequest(input: {
  id: number;
  toolName: string;
  arguments: Record<string, unknown>;
}): JsonRpcToolCall {
  return {
    jsonrpc: "2.0",
    id: input.id,
    method: "tools/call",
    params: { name: input.toolName, arguments: input.arguments },
  };
}

/** 序列化请求体,便于直接在界面展示。 */
export function serializeRequest(request: JsonRpcToolCall): string {
  return JSON.stringify(request, null, 2);
}

/** 把操作者输入的 Gateway 地址与已发布服务 slug 拼成 Streamable HTTP 端点。 */
export function resolveGatewayEndpoint(gatewayUrl: string, serviceSlug: string): string {
  const base = gatewayUrl.trim();
  if (!base) throw new Error("请输入 Gateway 地址");
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error("Gateway 地址不是合法的 URL,例如 http://localhost:4100");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Gateway 地址必须以 http:// 或 https:// 开头");
  }
  const prefix = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${prefix}/mcp/services/${encodeURIComponent(serviceSlug)}`;
}

export interface GatewayCallOutcome {
  ok: boolean;
  status: number;
  durationMs: number;
  bodyText: string;
  json: unknown;
  /** 网络层错误(未拿到 HTTP 响应);响应体内的错误由 bodyText 呈现。 */
  error: string | null;
}

/** 直接 POST 到 Gateway;返回原始响应,绝不回显或记录 API Key。 */
export async function sendGatewayRequest(input: {
  endpoint: string;
  apiKey: string;
  payload: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<GatewayCallOutcome> {
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new Error("请输入客户端 API Key");
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => Date.now());
  const startedAt = now();
  const elapsed = () => Math.max(0, Math.round(now() - startedAt));

  try {
    const response = await fetchImpl(input.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${apiKey}`,
      },
      body: input.payload,
    });
    const bodyText = await response.text();
    let json: unknown = null;
    try {
      json = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      json = null;
    }
    return {
      ok: response.ok,
      status: response.status,
      durationMs: elapsed(),
      bodyText,
      json,
      error: null,
    };
  } catch (reason) {
    return {
      ok: false,
      status: 0,
      durationMs: elapsed(),
      bodyText: "",
      json: null,
      error: reason instanceof Error ? reason.message : String(reason),
    };
  }
}

function defaultGatewayUrl(): string {
  return typeof window === "undefined" ? "http://localhost:4100" : window.location.origin;
}

function defaultVersion(
  versions: McpVersion[],
  service: McpService | undefined,
): McpVersion | null {
  const published = versions.filter((version) => version.status === "PUBLISHED");
  const current = published.find((version) => version.id === service?.currentVersionId);
  if (current) return current;
  if (published.length > 0) {
    return [...published].sort((left, right) => right.versionNumber - left.versionNumber)[0]!;
  }
  return [...versions].sort((left, right) => right.versionNumber - left.versionNumber)[0] ?? null;
}

function CodeBlock({ value }: { value: string }) {
  return <pre className="studio-code">{value}</pre>;
}

function messageFrom(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function DebugSandbox({ services = [] }: { services?: McpService[] }) {
  const [serviceId, setServiceId] = useState("");
  const [versions, setVersions] = useState<McpVersion[]>([]);
  const [versionId, setVersionId] = useState("");
  const [assetKind, setAssetKind] = useState<"tool" | "prompt">("tool");
  const [assetId, setAssetId] = useState("");
  const [argsText, setArgsText] = useState("{}");
  const [requestId, setRequestId] = useState(1);
  const [gatewayUrl, setGatewayUrl] = useState(defaultGatewayUrl);
  const [apiKey, setApiKey] = useState("");
  const [renderedPrompt, setRenderedPrompt] = useState("");
  const [outcome, setOutcome] = useState<GatewayCallOutcome | null>(null);
  const [busy, setBusy] = useState<"send" | "render" | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!serviceId && services.length > 0) setServiceId(services[0]!.id);
  }, [serviceId, services]);

  const service = useMemo(
    () => services.find((candidate) => candidate.id === serviceId),
    [serviceId, services],
  );

  useEffect(() => {
    if (!serviceId) {
      setVersions([]);
      setVersionId("");
      return;
    }
    let cancelled = false;
    setLoading(true);
    listVersions(serviceId)
      .then((next) => {
        if (cancelled) return;
        setVersions(next);
        setVersionId(defaultVersion(next, service)?.id ?? "");
        setAssetId("");
        setError("");
      })
      .catch((reason) => {
        if (!cancelled) setError(messageFrom(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // 仅在服务切换时重新拉取版本;service 只用于挑选默认版本。
  }, [serviceId]);

  const version = versions.find((candidate) => candidate.id === versionId) ?? null;
  const assets: Array<McpTool | McpPrompt> =
    assetKind === "tool" ? (version?.tools ?? []) : (version?.prompts ?? []);

  useEffect(() => {
    if (assets.length === 0) {
      setAssetId("");
      return;
    }
    if (!assets.some((asset) => asset.id === assetId)) setAssetId(assets[0]!.id);
  }, [assetKind, versionId, versions]);

  const asset = assets.find((candidate) => candidate.id === assetId) ?? null;
  const tool = assetKind === "tool" ? ((asset as McpTool | null) ?? null) : null;
  const prompt = assetKind === "prompt" ? ((asset as McpPrompt | null) ?? null) : null;

  const parsed = useMemo(() => parseArgumentsJson(argsText), [argsText]);
  const validationErrors = useMemo(() => {
    if (!parsed.ok) return [];
    if (tool) return validateToolArguments(tool.inputSchema, parsed.value);
    return Object.entries(parsed.value)
      .filter(([, value]) => typeof value !== "string")
      .map(([name]) => `${name} 必须是字符串`);
  }, [parsed, tool]);

  const requestBody = useMemo(() => {
    if (!tool || !parsed.ok) return "";
    return serializeRequest(
      buildToolCallRequest({ id: requestId, toolName: tool.name, arguments: parsed.value }),
    );
  }, [parsed, requestId, tool]);

  const resetOnSelection = useCallback(() => {
    setOutcome(null);
    setRenderedPrompt("");
    setError("");
  }, []);

  const send = async () => {
    if (!service || !version || !tool || !parsed.ok) return;
    setBusy("send");
    setOutcome(null);
    setError("");
    try {
      const endpoint = resolveGatewayEndpoint(gatewayUrl, service.slug);
      const body = serializeRequest(
        buildToolCallRequest({ id: requestId, toolName: tool.name, arguments: parsed.value }),
      );
      setOutcome(await sendGatewayRequest({ endpoint, apiKey, payload: body }));
      setRequestId((current) => current + 1);
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setBusy(null);
    }
  };

  const renderPrompt = async () => {
    if (!service || !version || !prompt || !parsed.ok) return;
    setBusy("render");
    setError("");
    setRenderedPrompt("");
    try {
      const values = Object.fromEntries(
        Object.entries(parsed.value).map(([name, value]) => [name, String(value)]),
      );
      const result = await previewPrompt(service.id, version.id, prompt.id, values);
      setRenderedPrompt(
        result.messages
          .map((message) => `${message.role.toUpperCase()}\n${message.content.text}`)
          .join("\n\n"),
      );
    } catch (reason) {
      setError(messageFrom(reason));
    } finally {
      setBusy(null);
    }
  };

  const canSend =
    tool !== null &&
    parsed.ok &&
    validationErrors.length === 0 &&
    apiKey.trim().length > 0 &&
    gatewayUrl.trim().length > 0 &&
    busy === null;

  return (
    <div className="mcp-operations-view">
      <div className="operations-toolbar">
        <div>
          <b>调试沙箱</b>
          <span>构造 JSON-RPC 请求并直接发送到 Gateway,不伪造执行结果</span>
        </div>
        <label className="compact-select">
          <span>服务</span>
          <select
            value={serviceId}
            onChange={(event) => {
              setServiceId(event.target.value);
              resetOnSelection();
            }}
          >
            <option value="">选择服务</option>
            {services.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name} ({candidate.status})
              </option>
            ))}
          </select>
        </label>
        <label className="compact-select">
          <span>版本</span>
          <select
            value={versionId}
            onChange={(event) => {
              setVersionId(event.target.value);
              setAssetId("");
              resetOnSelection();
            }}
          >
            <option value="">选择版本</option>
            {[...versions]
              .sort((left, right) => right.versionNumber - left.versionNumber)
              .map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  v{candidate.versionNumber} · {candidate.status}
                </option>
              ))}
          </select>
        </label>
        <div className="segmented-control" aria-label="资源类型">
          <button
            type="button"
            className={assetKind === "tool" ? "is-active" : ""}
            onClick={() => {
              setAssetKind("tool");
              resetOnSelection();
            }}
          >
            <CodeOutlined /> Tool
          </button>
          <button
            type="button"
            className={assetKind === "prompt" ? "is-active" : ""}
            onClick={() => {
              setAssetKind("prompt");
              resetOnSelection();
            }}
          >
            <FileTextOutlined /> Prompt
          </button>
        </div>
        <label className="compact-select">
          <span>{assetKind === "tool" ? "Tool" : "Prompt"}</span>
          <select value={assetId} onChange={(event) => setAssetId(event.target.value)}>
            <option value="">选择资源</option>
            {assets.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div
        className="workspace-notice"
        role="note"
        style={{ position: "static", transform: "none", maxWidth: "none", margin: "0 0 14px" }}
      >
        <ExperimentOutlined />
        真正的工具执行依赖后台 Worker 与 Docker 运行时。未部署 Worker 时 Gateway
        会返回执行错误(requestId 形如「Tool execution is unavailable」),这属于环境限制,
        不是沙箱缺陷;沙箱只如实展示 Gateway 的原始响应。
      </div>

      {error ? (
        <div className="workspace-notice error" role="status">
          {error}
        </div>
      ) : null}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(320px, 1fr) minmax(320px, 1fr)",
          gap: 18,
          alignItems: "start",
        }}
      >
        <section>
          <div className="inspector-section-title">参数(JSON)</div>
          {assetKind === "tool" && tool ? (
            <CodeBlock value={serializeSchema(tool.inputSchema)} />
          ) : null}
          {assetKind === "prompt" && prompt ? (
            <p className="muted-copy">
              Prompt 参数必须是字符串;渲染会调用控制面的 preview 接口,不会触达 Gateway。
            </p>
          ) : null}
          {loading ? (
            <div className="operations-empty">
              <LoadingOutlined spin />
              <p>正在读取版本资源</p>
            </div>
          ) : null}
          {!loading && !version ? (
            <div className="operations-empty">
              <ExperimentOutlined />
              <p>请选择服务与版本</p>
              <small>只有已发布版本的资源才会被 Gateway 执行。</small>
            </div>
          ) : null}
          {!loading && version && assets.length === 0 ? (
            <div className="operations-empty">
              <ExperimentOutlined />
              <p>该版本没有{assetKind === "tool" ? " Tool" : " Prompt"}</p>
            </div>
          ) : null}
          {version && asset ? (
            <label className="studio-field">
              <span>
                参数 JSON
                <small>{assetKind === "tool" ? "tools/call" : "prompts/get"}</small>
              </span>
              <Input.TextArea
                value={argsText}
                autoComplete="off"
                spellCheck={false}
                rows={8}
                onChange={(event) => setArgsText(event.target.value)}
              />
            </label>
          ) : null}
          {!parsed.ok ? <p className="field-message error">{parsed.error}</p> : null}
          {validationErrors.map((message) => (
            <p className="field-message error" key={message}>
              {message}
            </p>
          ))}
          {parsed.ok && validationErrors.length === 0 && asset ? (
            <p className="field-message">参数校验通过。</p>
          ) : null}
        </section>

        <section>
          <div className="inspector-section-title">
            {assetKind === "tool" ? "将要发送的 JSON-RPC 请求体" : "渲染后的 Prompt"}
          </div>
          {assetKind === "tool" ? (
            requestBody ? (
              <CodeBlock value={requestBody} />
            ) : (
              <p className="muted-copy">选择 Tool 并填写合法 JSON 参数后显示请求体。</p>
            )
          ) : null}
          {assetKind === "tool" ? (
            <>
              <label className="studio-field">
                <span>
                  Gateway 地址
                  <small>POST /mcp/services/{"{slug}"}</small>
                </span>
                <Input
                  value={gatewayUrl}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setGatewayUrl(event.target.value)}
                  placeholder="http://localhost:4100"
                />
              </label>
              <label className="studio-field">
                <span>
                  <KeyOutlined /> 客户端 API Key
                  <small>仅保存在组件内存</small>
                </span>
                <Input.Password
                  value={apiKey}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="mcp_..."
                />
              </label>
              <button
                className="studio-button secondary compact"
                type="button"
                onClick={() => {
                  setApiKey("");
                  setOutcome(null);
                }}
              >
                <UndoOutlined /> 清空 Key
              </button>
              {version &&
              service &&
              (service.status !== "ACTIVE" ||
                service.currentVersionId !== version.id ||
                version.status !== "PUBLISHED") ? (
                <p className="muted-copy">
                  Gateway 只执行服务当前已发布的版本;当前选择不会命中执行入口,响应会返回对应错误。
                </p>
              ) : null}
              <button
                className="studio-button primary full-width"
                type="button"
                disabled={!canSend}
                onClick={() => void send()}
              >
                {busy === "send" ? <LoadingOutlined spin /> : <SendOutlined />} 发送到 Gateway
              </button>
            </>
          ) : null}

          {assetKind === "prompt" ? (
            <>
              <button
                className="studio-button primary full-width"
                type="button"
                disabled={!prompt || !parsed.ok || validationErrors.length > 0 || busy !== null}
                onClick={() => void renderPrompt()}
              >
                {busy === "render" ? <LoadingOutlined spin /> : <ExperimentOutlined />} 渲染 Prompt
              </button>
              {renderedPrompt ? <CodeBlock value={renderedPrompt} /> : null}
            </>
          ) : null}

          {outcome ? (
            <div
              className={
                outcome.ok && !callFailed(outcome) ? "gateway-result" : "gateway-result is-error"
              }
            >
              <div className="gateway-result-heading">
                <span>
                  HTTP {outcome.status} · {outcome.durationMs}ms
                </span>
                <strong>{outcome.ok && !callFailed(outcome) ? "执行成功" : "执行失败"}</strong>
              </div>
              {outcome.error ? <p className="field-message error">{outcome.error}</p> : null}
              <CodeBlock value={outcome.bodyText || "(空响应体)"} />
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

/** 判断响应体里是否包含 JSON-RPC 错误或 Tool isError 结果。 */
function callFailed(outcome: GatewayCallOutcome): boolean {
  if (!isPlainObject(outcome.json)) return false;
  if (outcome.json.error !== undefined && outcome.json.error !== null) return true;
  const result = outcome.json.result;
  return isPlainObject(result) && result.isError === true;
}

function serializeSchema(schema: Record<string, unknown>): string {
  return JSON.stringify(schema ?? {}, null, 2);
}
