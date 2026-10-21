import type { RemoteServiceConfig } from "@open-agent-tools/mcp-contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

/** 远程服务暴露的一条 Tool 定义（取自上游 tools/list）。 */
export interface RemoteToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** 远程 tools/call 的结果，形如 MCP CallToolResult。 */
export interface RemoteToolResult {
  content: unknown;
  isError?: boolean;
}

/** 远程代理调用失败：网络/超时/协议错误统一抛出，由上层转成 MCP 错误。 */
export class RemoteMcpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteMcpError";
  }
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export interface RemoteMcpProxyOptions {
  /** 注入 fetch 便于测试；缺省用全局 fetch。 */
  fetch?: typeof fetch;
}

/**
 * 把第三方 MCP Server 接入统一网关：
 * - streamable-http：以 JSON-RPC 透传 initialize / tools/list / tools/call；
 * - sse：经 SDK Client 建连（GET 事件流 + POST 消息），上游多为旧版 MCP Server。
 *
 * 鉴权与审计仍在 Gateway 完成（API Key 校验、Scope、audit 事件），
 * 本类只负责与上游建立会话的协议细节：
 * - streamable-http：首次调用执行 initialize 并保存 Mcp-Session-Id，后续请求带上；
 * - 上游返回 SSE 或 JSON 均可解析；
 * - 超时由 AbortController/定时器控制。
 */
export class RemoteMcpProxy {
  readonly #config: RemoteServiceConfig;
  readonly #fetch: typeof fetch;
  #sessionId: string | null = null;
  #initialized = false;
  #nextId = 1;

  constructor(config: RemoteServiceConfig, options: RemoteMcpProxyOptions = {}) {
    this.#config = config;
    this.#fetch = options.fetch ?? fetch;
  }

  /** 拉取上游 Tool 列表（自动完成 initialize）。 */
  async listTools(): Promise<RemoteToolDefinition[]> {
    if (this.#config.transport === "sse") {
      return this.#withSseClient(async (client) => {
        const result = await client.listTools(undefined, { timeout: this.#config.timeoutMs });
        return normalizeTools(result.tools ?? []);
      });
    }
    const result = (await this.#request("tools/list", {})) as {
      tools?: Array<{ name?: unknown; description?: unknown; inputSchema?: unknown }>;
    };
    const tools = Array.isArray(result.tools) ? result.tools : [];
    return normalizeTools(tools);
  }

  /** 透传 tools/call 到上游。 */
  async callTool(name: string, args: Record<string, unknown>): Promise<RemoteToolResult> {
    if (this.#config.transport === "sse") {
      return this.#withSseClient(async (client) => {
        const result = await client.callTool({ name, arguments: args }, undefined, {
          timeout: this.#config.timeoutMs,
        });
        return {
          content: (result as { content?: unknown }).content ?? null,
          ...(result.isError === true ? { isError: true } : {}),
        };
      });
    }
    const result = (await this.#request("tools/call", { name, arguments: args })) as {
      content?: unknown;
      isError?: unknown;
    };
    return {
      content: result.content ?? null,
      ...(result.isError === true ? { isError: true } : {}),
    };
  }

  /** SSE 上游：每次调用独立建连、用完即关（代理实例本来就是按网关请求创建的）。 */
  async #withSseClient<T>(task: (client: Client) => Promise<T>): Promise<T> {
    const headers: Record<string, string> = { ...this.#sseAuthHeaders() };
    const innerFetch = this.#fetch;
    // SSE 首个 GET 由 EventSource 发起（不支持自定义 header），用包装 fetch 注入鉴权头。
    const authedFetch = (async (url: unknown, init?: Record<string, unknown>) => {
      const merged = {
        ...(init ?? {}),
        headers: {
          ...headers,
          ...((init?.["headers"] as Record<string, string> | undefined) ?? {}),
        },
      };
      return innerFetch(url as string, merged as RequestInit);
    }) as unknown as typeof globalThis.fetch;
    const client = new Client({ name: "open-agent-tools-gateway", version: "1.0.0" });
    const transport = new SSEClientTransport(new URL(this.#config.url), {
      fetch: authedFetch,
      requestInit: { headers },
    });
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        client.connect(transport),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new RemoteMcpError("Remote MCP request timed out")),
            this.#config.timeoutMs,
          );
        }),
      ]);
      return await task(client);
    } catch (error) {
      if (error instanceof RemoteMcpError) throw error;
      if (error instanceof Error && /timed out|timeout/i.test(error.message)) {
        throw new RemoteMcpError("Remote MCP request timed out");
      }
      throw new RemoteMcpError(
        error instanceof Error
          ? `Remote MCP request failed: ${error.message}`
          : "Remote MCP request failed",
      );
    } finally {
      if (timeout !== null) clearTimeout(timeout);
      await client.close().catch(() => undefined);
    }
  }

  #sseAuthHeaders(): Record<string, string> {
    return {
      ...(this.#config.token === undefined
        ? {}
        : { authorization: `Bearer ${this.#config.token}` }),
      ...(this.#config.headers ?? {}),
    };
  }

  async #ensureSession(): Promise<void> {
    if (this.#initialized) return;
    const result = (await this.#post({
      jsonrpc: "2.0",
      id: this.#nextId++,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "open-agent-tools-gateway", version: "1.0.0" },
      },
    })) as { protocolVersion?: unknown };
    if (typeof result !== "object" || result === null) {
      throw new RemoteMcpError("Remote MCP initialize returned no result");
    }
    // initialized 通知无 id、无需响应。
    await this.#notify("notifications/initialized", {}).catch(() => undefined);
    this.#initialized = true;
  }

  async #request(method: string, params: unknown): Promise<unknown> {
    await this.#ensureSession();
    return this.#post({ jsonrpc: "2.0", id: this.#nextId++, method, params });
  }

  async #notify(method: string, params: unknown): Promise<void> {
    await this.#raw({ jsonrpc: "2.0", method, params });
  }

  async #post(payload: Record<string, unknown>): Promise<unknown> {
    const body = await this.#raw(payload);
    if (body === null) return null;
    const response = body as JsonRpcResponse;
    if (response.error) {
      throw new RemoteMcpError(response.error.message ?? "Remote MCP returned an error");
    }
    return response.result ?? null;
  }

  async #raw(payload: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#config.timeoutMs);
    try {
      const response = await this.#fetch(this.#config.url, {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const sessionId = response.headers.get("mcp-session-id");
      if (sessionId) this.#sessionId = sessionId;
      const text = await response.text();
      if (!response.ok) {
        throw new RemoteMcpError(`Remote MCP responded with status ${response.status}`);
      }
      return parseBody(text, response.headers.get("content-type"));
    } catch (error) {
      if (error instanceof RemoteMcpError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new RemoteMcpError("Remote MCP request timed out");
      }
      throw new RemoteMcpError(
        error instanceof Error
          ? `Remote MCP request failed: ${error.message}`
          : "Remote MCP request failed",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  #headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (this.#config.token) headers.authorization = `Bearer ${this.#config.token}`;
    Object.assign(headers, this.#config.headers ?? {});
    if (this.#sessionId) headers["mcp-session-id"] = this.#sessionId;
    return headers;
  }
}

/** 上游 Tool 归一化：过滤非法条目、缺 inputSchema 时补默认空对象。 */
function normalizeTools(
  tools: Array<{ name?: unknown; description?: unknown; inputSchema?: unknown }>,
): RemoteToolDefinition[] {
  return tools
    .filter(
      (tool): tool is { name: string; description?: unknown; inputSchema?: unknown } =>
        typeof tool?.name === "string" && tool.name.length > 0,
    )
    .map((tool) => ({
      name: tool.name,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      inputSchema:
        typeof tool.inputSchema === "object" && tool.inputSchema !== null
          ? (tool.inputSchema as Record<string, unknown>)
          : { type: "object" },
    }));
}

/** 解析上游响应：JSON 直返，或 SSE（data: 行）中的最后一个 JSON 负载。 */
function parseBody(text: string, contentType: string | null): unknown {
  if (text.length === 0) return null;
  if (
    contentType?.includes("text/event-stream") ||
    text.startsWith("event:") ||
    text.startsWith("data:")
  ) {
    const payloads = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .filter((line) => line.length > 0);
    if (payloads.length === 0) return null;
    return JSON.parse(payloads[payloads.length - 1]!);
  }
  return JSON.parse(text);
}
