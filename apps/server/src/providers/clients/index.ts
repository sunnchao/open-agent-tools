import type { ProviderWithKey } from "../store.js";
import { PROVIDER_FORMAT_LABELS, isProviderFormat } from "../formats.js";
import { logDebugDuration, truncate } from "../../trace.js";
import type { LlmClient } from "./types.js";
import { OpenAIChatClient } from "./openai-chat.js";
import { OpenAIResponseClient } from "./openai-response.js";
import { AnthropicMessageClient } from "./anthropic-message.js";

export type { LlmClient, LlmMessage, LlmToolDefinition, LlmStreamResult, LlmCompleteResult } from "./types.js";

/**
 * 用 debug 耗时日志包一层,统一覆盖三种 format 实现,避免在每个 client 类里重复计时代码。
 * 仅在 DEBUG=true 时输出(见 trace.ts),记录耗时、token 用量与响应大小,便于定位慢请求。
 * 用 Proxy 而不是普通对象转发,保留 `instanceof OpenAIChatClient` 等具体类型判断(见 clients.test.ts)。
 */
function withDebugLogging(client: LlmClient, provider: ProviderWithKey): LlmClient {
  const debugComplete: LlmClient["complete"] = async (params) => {
    const startedAt = Date.now();
    try {
      const result = await client.complete(params);
      logDebugDuration("llm.complete", startedAt, {
        providerId: provider.id,
        format: client.format,
        model: params.model,
        contentLength: result.content.length,
        inputTokens: result.tokenUsage?.inputTokens,
        outputTokens: result.tokenUsage?.outputTokens,
      });
      return result;
    } catch (error) {
      logDebugDuration("llm.complete_error", startedAt, {
        providerId: provider.id,
        format: client.format,
        model: params.model,
        error: truncate(error instanceof Error ? error.message : String(error), 500),
      });
      throw error;
    }
  };
  const debugStreamChat: LlmClient["streamChat"] = async (params) => {
    const startedAt = Date.now();
    try {
      const result = await client.streamChat(params);
      logDebugDuration("llm.stream_chat", startedAt, {
        providerId: provider.id,
        format: client.format,
        model: params.model,
        toolCalls: result.toolCalls.length,
        contentLength: result.content.length,
        inputTokens: result.tokenUsage?.inputTokens,
        outputTokens: result.tokenUsage?.outputTokens,
      });
      return result;
    } catch (error) {
      logDebugDuration("llm.stream_chat_error", startedAt, {
        providerId: provider.id,
        format: client.format,
        model: params.model,
        error: truncate(error instanceof Error ? error.message : String(error), 500),
      });
      throw error;
    }
  };
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "complete") return debugComplete;
      if (prop === "streamChat") return debugStreamChat;
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** 按 Provider 的 format 创建对应的 LLM 客户端。 */
export function createLlmClient(provider: ProviderWithKey): LlmClient {
  const client = ((): LlmClient => {
    switch (provider.format) {
      case "openai-chat":
        return new OpenAIChatClient(provider);
      case "openai-response":
        return new OpenAIResponseClient(provider);
      case "anthropic-message":
        return new AnthropicMessageClient(provider);
      default:
        throw new Error(
          `未知的 Provider 格式: ${String(provider.format)}（可选: ${Object.values(PROVIDER_FORMAT_LABELS).join("、")}）`,
        );
    }
  })();
  return withDebugLogging(client, provider);
}

export function isSupportedProviderFormat(value: unknown): boolean {
  return isProviderFormat(value);
}
