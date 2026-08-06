import type { ProviderWithKey } from "../store.js";
import { PROVIDER_FORMAT_LABELS, isProviderFormat } from "../formats.js";
import type { LlmClient } from "./types.js";
import { OpenAIChatClient } from "./openai-chat.js";
import { OpenAIResponseClient } from "./openai-response.js";
import { AnthropicMessageClient } from "./anthropic-message.js";

export type { LlmClient, LlmMessage, LlmToolDefinition, LlmStreamResult, LlmCompleteResult } from "./types.js";

/** 按 Provider 的 format 创建对应的 LLM 客户端。 */
export function createLlmClient(provider: ProviderWithKey): LlmClient {
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
}

export function isSupportedProviderFormat(value: unknown): boolean {
  return isProviderFormat(value);
}
