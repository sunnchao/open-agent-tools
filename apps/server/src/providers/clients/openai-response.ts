import { OpenAI } from "openai";
import type { FunctionTool } from "openai/resources/responses/responses";
import type { ProviderWithKey } from "../store.js";
import type {
  LlmClient,
  LlmCompleteResult,
  LlmMessage,
  LlmStreamResult,
  LlmToolDefinition,
} from "./types.js";

/**
 * 将统一 LlmMessage 转换为 Responses API 的 input 项。
 * - system 消息合并到 instructions（顶层参数）；
 * - user/assistant 消息映射为 EasyInputMessage；
 * - assistant 的工具调用映射为 function_call 项；
 * - tool 结果映射为 function_call_output 项。
 */
export function toResponseInput(messages: LlmMessage[]): {
  instructions: string | undefined;
  input: unknown[];
} {
  const input: unknown[] = [];
  const systemParts: string[] = [];
  for (const message of messages) {
    switch (message.role) {
      case "system":
        if (message.content) systemParts.push(message.content);
        break;
      case "user":
        input.push({ role: "user", content: message.content });
        break;
      case "assistant": {
        input.push({ role: "assistant", content: message.content });
        for (const call of message.tool_calls ?? []) {
          input.push({
            type: "function_call",
            call_id: call.id,
            name: call.name,
            arguments: call.arguments,
          });
        }
        break;
      }
      case "tool":
        input.push({
          type: "function_call_output",
          call_id: message.tool_call_id ?? "",
          output: message.content,
        });
        break;
    }
  }
  return {
    instructions: systemParts.length ? systemParts.join("\n\n") : undefined,
    input,
  };
}

function toResponseTools(tools: LlmToolDefinition[]): FunctionTool[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  }));
}

/**
 * OpenAI Responses 格式（/v1/responses）。
 * 与 Chat Completions 的关键差异：
 * - 顶层 `instructions` 承载系统提示；
 * - input/output 均为 item 数组（message / function_call / function_call_output）；
 * - 工具调用增量事件为 `response.function_call_arguments.delta`。
 */
export class OpenAIResponseClient implements LlmClient {
  readonly format = "openai-response" as const;

  constructor(private readonly provider: ProviderWithKey) {}

  private client(): OpenAI {
    return new OpenAI({
      apiKey: this.provider.apiKey ?? "",
      baseURL: this.provider.baseUrl,
    });
  }

  async streamChat(params: {
    model: string;
    messages: LlmMessage[];
    tools?: LlmToolDefinition[];
    signal?: AbortSignal;
    callbacks: { onDelta: (delta: string) => void };
  }): Promise<LlmStreamResult> {
    const { model, messages, tools, signal, callbacks } = params;
    const { instructions, input } = toResponseInput(messages);
    const stream = await this.client().responses.create(
      {
        model,
        ...(instructions ? { instructions } : {}),
        input: input as never,
        ...(tools?.length ? { tools: toResponseTools(tools) } : {}),
        stream: true,
      },
      { signal },
    );

    const callsByIndex = new Map<number, { id?: string; name?: string; arguments: string }>();
    let content = "";
    for await (const event of stream) {
      switch (event.type) {
        case "response.output_text.delta":
          if (event.delta) {
            content += event.delta;
            callbacks.onDelta(event.delta);
          }
          break;
        case "response.output_item.done":
          if (event.item.type === "function_call") {
            callsByIndex.set(event.output_index, {
              id: event.item.call_id,
              name: event.item.name,
              arguments: event.item.arguments,
            });
          }
          break;
      }
    }

    const toolCalls = [...callsByIndex.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => ({ ...call, id: call.id ?? `call_${Date.now()}` }))
      .filter((call): call is { id: string; name: string; arguments: string } => Boolean(call.name));

    return { content, toolCalls };
  }

  async complete(params: {
    model: string;
    messages: LlmMessage[];
    temperature?: number;
    signal?: AbortSignal;
  }): Promise<LlmCompleteResult> {
    const { model, messages, temperature, signal } = params;
    const { instructions, input } = toResponseInput(messages);
    const response = await this.client().responses.create(
      {
        model,
        ...(instructions ? { instructions } : {}),
        input: input as never,
        ...(temperature === undefined ? {} : { temperature }),
        stream: false,
      },
      { signal },
    );
    return {
      content: response.output_text ?? "",
      tokenUsage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      },
    };
  }
}
