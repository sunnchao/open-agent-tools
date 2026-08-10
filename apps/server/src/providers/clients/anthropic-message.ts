import type { ProviderWithKey } from "../store.js";
import type {
  LlmClient,
  LlmCompleteResult,
  LlmMessage,
  LlmStreamResult,
  LlmToolDefinition,
} from "./types.js";

const DEFAULT_MAX_TOKENS = 4096;
const ANTHROPIC_VERSION = "2023-06-01";

/** Anthropic Messages 端点：baseUrl 可能带 /v1 或不带，统一归一化到 /v1/messages。 */
export function messagesEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return `${trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`}/messages`;
}

export interface AnthropicBlock {
  type: string;
  [key: string]: unknown;
}

interface AnthropicMessageEvent {
  type: string;
  index?: number;
  delta?: { type?: string; text?: string; partial_json?: string };
  content_block?: { type?: string; id?: string; name?: string };
  error?: { type?: string; message?: string };
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  usage?: { output_tokens?: number };
}

/** 将统一消息转换为 Anthropic 格式。 */
export function toAnthropicPayload(
  messages: LlmMessage[],
  tools: LlmToolDefinition[] | undefined,
  model: string,
  stream: boolean,
): {
  body: Record<string, unknown>;
  system: string;
} {
  const systemParts: string[] = [];
  // Anthropic 要求 user/assistant 严格交替；连续 tool 结果必须合并到同一个 user 消息。
  const blocks: Array<{ role: "user" | "assistant"; content: AnthropicBlock[] }> = [];

  const pushBlock = (role: "user" | "assistant", content: AnthropicBlock[]) => {
    const last = blocks[blocks.length - 1];
    if (last && last.role === role) {
      last.content.push(...content);
    } else {
      blocks.push({ role, content: [...content] });
    }
  };

  for (const message of messages) {
    switch (message.role) {
      case "system":
        if (message.content) systemParts.push(message.content);
        break;
      case "user":
        pushBlock("user", [{ type: "text", text: message.content }]);
        break;
      case "assistant": {
        const content: AnthropicBlock[] = [];
        if (message.content) content.push({ type: "text", text: message.content });
        for (const call of message.tool_calls ?? []) {
          content.push({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: safeParseJson(call.arguments),
          });
        }
        pushBlock("assistant", content);
        break;
      }
      case "tool":
        pushBlock("user", [
          {
            type: "tool_result",
            tool_use_id: message.tool_call_id ?? "",
            content: message.content,
          },
        ]);
        break;
    }
  }

  return {
    system: systemParts.join("\n\n"),
    body: {
      model,
      max_tokens: DEFAULT_MAX_TOKENS,
      ...(systemParts.length ? { system: systemParts.join("\n\n") } : {}),
      messages: blocks.map((block) => ({
        role: block.role,
        content: block.content,
      })),
      ...(tools?.length
        ? {
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.parameters,
            })),
          }
        : {}),
      ...(stream ? { stream: true } : {}),
    },
  };
}

function safeParseJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 从 ReadableStream 中解析 SSE 事件。 */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<AnthropicMessageEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let separator: number;
    while ((separator = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const data = rawEvent
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        yield JSON.parse(data) as AnthropicMessageEvent;
      } catch {
        // 忽略解析失败的残缺事件
      }
    }
  }
  if (buffer.trim()) {
    const data = buffer
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) {
      try {
        yield JSON.parse(data) as AnthropicMessageEvent;
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Anthropic Messages 格式（/v1/messages）。
 * 关键差异：
 * - system 是独立顶层参数；
 * - content 为 block 数组（text / tool_use / tool_result）；
 * - 流式通过 content_block_delta 事件携带增量。
 */
export class AnthropicMessageClient implements LlmClient {
  readonly format = "anthropic-message" as const;

  constructor(private readonly provider: ProviderWithKey) {}

  private async request(
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const response = await fetch(messagesEndpoint(this.provider.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.provider.apiKey ?? "",
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const message =
        text.length > 500 ? `${text.slice(0, 500)}…` : text || `HTTP ${response.status}`;
      throw new Error(`Anthropic request failed: ${message}`);
    }
    return response;
  }

  async streamChat(params: {
    model: string;
    messages: LlmMessage[];
    tools?: LlmToolDefinition[];
    signal?: AbortSignal;
    callbacks: { onDelta: (delta: string) => void };
  }): Promise<LlmStreamResult> {
    const { model, messages, tools, signal, callbacks } = params;
    const { body } = toAnthropicPayload(messages, tools, model, true);
    const response = await this.request(body, signal);
    if (!response.body) throw new Error("Anthropic response has no body");

    const callsByIndex = new Map<number, { id?: string; name?: string; arguments: string }>();
    let content = "";
    let inputTokens = 0;
    let outputTokens = 0;
    for await (const event of sseEvents(response.body)) {
      if (event.type === "error") {
        throw new Error(event.error?.message ?? "Anthropic stream error");
      }
      if (event.type === "message_start" && event.message?.usage?.input_tokens) {
        inputTokens = event.message.usage.input_tokens;
      }
      if (event.type === "message_delta" && event.usage?.output_tokens) {
        outputTokens = event.usage.output_tokens;
      }
      if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
        const index = event.index ?? callsByIndex.size;
        callsByIndex.set(index, {
          id: event.content_block.id,
          name: event.content_block.name,
          arguments: "",
        });
        continue;
      }
      if (event.type === "content_block_delta") {
        if (event.delta?.type === "text_delta" && event.delta.text) {
          content += event.delta.text;
          callbacks.onDelta(event.delta.text);
        } else if (event.delta?.type === "input_json_delta" && event.delta.partial_json) {
          const index = event.index ?? 0;
          const current = callsByIndex.get(index) ?? { arguments: "" };
          current.arguments += event.delta.partial_json;
          callsByIndex.set(index, current);
        }
      }
    }

    const toolCalls = [...callsByIndex.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => ({ ...call, id: call.id ?? `call_${Date.now()}` }))
      .filter((call): call is { id: string; name: string; arguments: string } => Boolean(call.name));

    return { content, toolCalls, tokenUsage: { inputTokens, outputTokens } };
  }

  async complete(params: {
    model: string;
    messages: LlmMessage[];
    temperature?: number;
    signal?: AbortSignal;
  }): Promise<LlmCompleteResult> {
    const { model, messages, temperature, signal } = params;
    const { body } = toAnthropicPayload(messages, undefined, model, false);
    if (temperature !== undefined) body.temperature = temperature;
    const response = await this.request(body, signal);
    const data = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
      error?: { message?: string };
    };
    if (data.error) throw new Error(data.error.message);
    const text = (data.content ?? [])
      .filter((block) => block.type === "text" && block.text)
      .map((block) => block.text ?? "")
      .join("");
    return {
      content: text,
      tokenUsage: {
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
      },
    };
  }
}
