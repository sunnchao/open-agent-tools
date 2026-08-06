import { OpenAI } from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions";
import type { ProviderWithKey } from "../store.js";
import type {
  LlmClient,
  LlmCompleteResult,
  LlmMessage,
  LlmStreamCallbacks,
  LlmStreamResult,
  LlmToolDefinition,
} from "./types.js";

function toChatCompletionMessage(message: LlmMessage): ChatCompletionMessageParam | null {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content };
    case "user":
      return { role: "user", content: message.content };
    case "assistant":
      return {
        role: "assistant",
        content: message.content || null,
        ...(message.tool_calls?.length
          ? {
              tool_calls: message.tool_calls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      };
    case "tool":
      return { role: "tool", tool_call_id: message.tool_call_id ?? "", content: message.content };
  }
}

function toToolDefinitions(tools: LlmToolDefinition[]): NonNullable<
  Parameters<OpenAI["chat"]["completions"]["create"]>[0]["tools"]
> {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

/**
 * OpenAI Chat Completions 格式（/v1/chat/completions，OpenAI 兼容服务均支持）。
 */
export class OpenAIChatClient implements LlmClient {
  readonly format = "openai-chat" as const;

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
    callbacks: LlmStreamCallbacks;
  }): Promise<LlmStreamResult> {
    const { model, messages, tools, signal, callbacks } = params;
    const completionMessages = messages
      .map(toChatCompletionMessage)
      .filter((m): m is ChatCompletionMessageParam => m !== null);
    const stream = await this.client().chat.completions.create(
      {
        model,
        messages: completionMessages,
        stream: true,
        ...(tools?.length ? { tools: toToolDefinitions(tools) } : {}),
      },
      { signal },
    );

    const callsByIndex = new Map<number, { id?: string; name?: string; arguments: string }>();
    let content = "";
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;
      if (choice.delta?.content) {
        content += choice.delta.content;
        callbacks.onDelta(choice.delta.content);
      }
      for (const toolCall of choice.delta?.tool_calls ?? []) {
        const index = toolCall.index ?? 0;
        const current = callsByIndex.get(index) ?? { arguments: "" };
        if (toolCall.id) current.id = toolCall.id;
        if (toolCall.function?.name) current.name = (current.name ?? "") + toolCall.function.name;
        if (toolCall.function?.arguments) current.arguments += toolCall.function.arguments;
        callsByIndex.set(index, current);
      }
    }

    const toolCalls = [...callsByIndex.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call], index) => ({ ...call, id: call.id ?? `call_${index}` }))
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
    const completionMessages = messages
      .map(toChatCompletionMessage)
      .filter((m): m is ChatCompletionMessageParam => m !== null);
    const response = await this.client().chat.completions.create(
      {
        model,
        messages: completionMessages,
        ...(temperature === undefined ? {} : { temperature }),
        stream: false,
      },
      { signal },
    );
    return {
      content: response.choices[0]?.message?.content ?? "",
      tokenUsage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }
}
