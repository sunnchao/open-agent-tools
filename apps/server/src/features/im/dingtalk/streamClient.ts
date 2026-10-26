import { logTrace } from "../../../platform/trace.js";

/** 钉钉 Stream 网关注册接口：换取 WebSocket endpoint 与一次性 ticket。 */
const GATEWAY_OPEN_URL = "https://api.dingtalk.com/v1.0/gateway/connections/open";
/** 机器人消息回调 topic。 */
export const DINGTALK_BOT_MESSAGE_TOPIC = "/v1.0/im/bot/messages/get";
const DEFAULT_UA = "open-agent-tools-dingtalk-stream/1.0";
const WS_OPEN = 1;

/**
 * 最小 WebSocket 抽象：仅覆盖 Stream 客户端用到的能力。
 * 默认用 Node 24 全局 WebSocket（undici 内置）；单测可注入假实现。
 * 事件参数保持宽松（unknown/最小结构），避免依赖 DOM lib 类型。
 */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface DingTalkStreamClientOptions {
  clientId: string;
  clientSecret: string;
  /** 上报给钉钉的客户端标识，便于平台侧排障。 */
  ua?: string;
  /** 收到 CALLBACK 推送时的业务处理函数；data 为已反序列化的回调 JSON。 */
  onMessage?: (data: unknown) => void | Promise<void>;
  /** 单测注入；默认用全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 单测注入；默认用全局 WebSocket。 */
  webSocketFactory?: (url: string) => WebSocketLike;
  /** 重连初始延迟（毫秒），默认 1000。 */
  reconnectBaseDelayMs?: number;
  /** 重连延迟上限（毫秒），默认 60000。 */
  reconnectMaxDelayMs?: number;
  /** 抖动随机源，默认 Math.random。 */
  random?: () => number;
}

interface GatewayOpenResponse {
  endpoint?: unknown;
  ticket?: unknown;
}

interface StreamPushMessage {
  type?: string;
  headers?: { topic?: string; messageId?: string; contentType?: string };
  data?: string;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * 手写钉钉 Stream 协议客户端（不引入 dingtalk-stream SDK）。
 *
 * 生命周期：connect() 注册连接凭证并建立 WebSocket；断线后指数退避重连
 * （1s 起、60s 上限、带随机抖动）；disconnect() 永久停止并清理定时器。
 */
export class DingTalkStreamClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly ua: string;
  private readonly onMessageHandler: ((data: unknown) => void | Promise<void>) | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly webSocketFactory: (url: string) => WebSocketLike;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly random: () => number;

  private socket: WebSocketLike | null = null;
  private connected = false;
  private stopped = true;
  private connectPromise: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private lastError: string | undefined;

  constructor(options: DingTalkStreamClientOptions) {
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.ua = options.ua ?? DEFAULT_UA;
    this.onMessageHandler = options.onMessage;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.webSocketFactory =
      options.webSocketFactory ??
      ((url: string): WebSocketLike => new WebSocket(url) as unknown as WebSocketLike);
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 1000;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 60_000;
    this.random = options.random ?? Math.random;
  }

  /**
   * 建立连接。
   * 首次失败会抛可读错误，同时自动排一次指数退避重连（除非已 disconnect），
   * 避免渠道因一次抖动永久停在「未连接」。
   */
  async connect(): Promise<void> {
    if (this.connected && this.socket?.readyState === WS_OPEN) return;
    if (this.connectPromise) return this.connectPromise;
    this.stopped = false;
    this.connectPromise = this.openSocket()
      .then(() => {
        this.lastError = undefined;
      })
      .catch((error: unknown) => {
        const message = errorMessage(error);
        this.connected = false;
        this.lastError = message;
        if (!this.stopped) this.scheduleReconnect();
        throw error instanceof Error ? error : new Error(message);
      })
      .finally(() => {
        this.connectPromise = null;
      });
    return this.connectPromise;
  }

  /** 主动断开并停止自动重连（幂等）。 */
  disconnect(): void {
    this.stopped = true;
    this.connected = false;
    this.clearReconnectTimer();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close(1000, "client disconnect");
      } catch {
        // 关闭失败无需处理
      }
    }
  }

  isConnected(): boolean {
    return this.connected && this.socket?.readyState === WS_OPEN;
  }

  /** 最近一次连接错误（状态上报用）。 */
  getLastError(): string | undefined {
    return this.lastError;
  }

  private async openSocket(): Promise<void> {
    const { endpoint, ticket } = await this.openGatewayConnection();
    // 握手期间被 disconnect()：静默结束，避免把主动停止误报成连接失败。
    if (this.stopped) return;

    const separator = endpoint.includes("?") ? "&" : "?";
    const url = `${endpoint}${separator}ticket=${encodeURIComponent(ticket)}`;
    const socket = this.webSocketFactory(url);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let opened = false;
      socket.onopen = () => {
        opened = true;
        this.connected = true;
        this.lastError = undefined;
        this.reconnectAttempt = 0;
        logTrace("im.dingtalk.stream.connected", { endpoint });
        resolve();
      };
      socket.onmessage = (event) => {
        this.handlePush(event.data);
      };
      socket.onerror = (event) => {
        const message = errorMessage(event);
        this.lastError = `dingtalk websocket error: ${message}`;
        logTrace("im.dingtalk.stream.error", { error: message }, "error");
        if (!opened) {
          // 握手阶段出错：清掉半开 socket，避免重连被 this.socket 拦住。
          if (this.socket === socket) this.socket = null;
          try {
            socket.close();
          } catch {
            // 忽略关闭失败
          }
          reject(new Error(this.lastError));
        }
      };
      socket.onclose = (event) => {
        const wasConnected = this.connected;
        this.connected = false;
        if (this.socket === socket) this.socket = null;
        const detail = [event?.code, event?.reason].filter(Boolean).join(" ");
        // 主动 disconnect 触发的关闭：静默收尾，不重连也不报错。
        if (this.stopped) {
          if (!opened) resolve();
          return;
        }
        if (!opened) {
          reject(new Error(`dingtalk websocket closed before open${detail ? ` (${detail})` : ""}`));
          return;
        }
        if (wasConnected) {
          logTrace("im.dingtalk.stream.closed", { detail: detail || "closed" }, "warn");
          this.scheduleReconnect();
        }
      };
    });
  }

  private async openGatewayConnection(): Promise<{ endpoint: string; ticket: string }> {
    let response: Response;
    try {
      response = await this.fetchImpl(GATEWAY_OPEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          clientId: this.clientId,
          clientSecret: this.clientSecret,
          ua: this.ua,
          subscriptions: [{ type: "CALLBACK", topic: DINGTALK_BOT_MESSAGE_TOPIC }],
        }),
      });
    } catch (error) {
      throw new Error(`dingtalk gateway open failed: ${errorMessage(error)}`);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `dingtalk gateway open failed (HTTP ${response.status}): ${detail.slice(0, 300)}`,
      );
    }
    let body: GatewayOpenResponse;
    try {
      body = (await response.json()) as GatewayOpenResponse;
    } catch (error) {
      throw new Error(`dingtalk gateway open returned invalid JSON: ${errorMessage(error)}`);
    }
    const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
    const ticket = typeof body.ticket === "string" ? body.ticket.trim() : "";
    if (!endpoint || !ticket) {
      throw new Error("dingtalk gateway open returned no endpoint/ticket");
    }
    return { endpoint, ticket };
  }

  private handlePush(raw: unknown): void {
    if (typeof raw !== "string") {
      logTrace("im.dingtalk.stream.unsupported_frame", { dataType: typeof raw }, "warn");
      return;
    }
    let message: StreamPushMessage;
    try {
      message = JSON.parse(raw) as StreamPushMessage;
    } catch {
      logTrace("im.dingtalk.stream.invalid_json", { preview: raw.slice(0, 120) }, "warn");
      return;
    }
    const topic = message.headers?.topic ?? "";
    const messageId = message.headers?.messageId ?? "";

    if (message.type === "SYSTEM") {
      if (topic === "ping") {
        // 探活要求把 data（含 opaque）原样回传。
        this.sendAck(messageId, message.data ?? "");
        return;
      }
      if (topic === "disconnect") {
        this.sendAck(messageId, message.data ?? "");
        logTrace("im.dingtalk.stream.server_disconnect", { messageId }, "warn");
        this.closeForReconnect();
        return;
      }
      logTrace("im.dingtalk.stream.unknown_system_topic", { topic }, "warn");
      return;
    }

    if (message.type === "CALLBACK" && topic === DINGTALK_BOT_MESSAGE_TOPIC) {
      let data: unknown = {};
      if (typeof message.data === "string" && message.data) {
        try {
          data = JSON.parse(message.data) as unknown;
        } catch {
          logTrace("im.dingtalk.stream.invalid_callback_data", { messageId }, "warn");
        }
      }
      // 先 ACK 再异步执行业务：LLM 生成可能耗时数十秒，不能阻塞钉钉的等待窗口。
      this.sendAck(messageId, JSON.stringify({ response: null }));
      void (async () => {
        try {
          await this.onMessageHandler?.(data);
        } catch (error) {
          logTrace("im.dingtalk.stream.handler_error", { error: errorMessage(error) }, "error");
        }
      })();
      return;
    }

    logTrace("im.dingtalk.stream.unhandled_push", { type: message.type, topic }, "warn");
  }

  private sendAck(messageId: string, data: string): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WS_OPEN) return;
    try {
      socket.send(
        JSON.stringify({
          code: 200,
          headers: { contentType: "application/json", messageId },
          message: "OK",
          data,
        }),
      );
    } catch (error) {
      logTrace("im.dingtalk.stream.ack_error", { error: errorMessage(error) }, "error");
    }
  }

  /** 服务端主动 disconnect：先 ACK，再关闭连接并由 onclose 触发重连。 */
  private closeForReconnect(): void {
    const socket = this.socket;
    if (!socket) {
      this.scheduleReconnect();
      return;
    }
    try {
      socket.close(1000, "server disconnect");
    } catch {
      // 关闭失败时直接按已断开处理
      this.socket = null;
      this.connected = false;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const attempt = this.reconnectAttempt;
    this.reconnectAttempt += 1;
    const exponential = Math.min(
      this.reconnectMaxDelayMs,
      this.reconnectBaseDelayMs * 2 ** attempt,
    );
    const jittered = Math.min(
      this.reconnectMaxDelayMs,
      Math.max(0, Math.round(exponential * (0.75 + this.random() * 0.5))),
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      if (this.connected || this.socket) return;
      void this.reconnect();
    }, jittered);
    logTrace("im.dingtalk.stream.reconnect_scheduled", { delayMs: jittered, attempt });
  }

  private async reconnect(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.connect();
    } catch (error) {
      // connect() 内部已排下一轮退避；这里只记录，避免重复定时器。
      const message = errorMessage(error);
      this.lastError = message;
      logTrace("im.dingtalk.stream.reconnect_error", { error: message }, "error");
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
