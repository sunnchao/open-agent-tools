/**
 * Provider 的接入格式（协议方言）。
 * 设置页创建 Provider 时必须指定格式，服务端按格式选择对应的 LLM 客户端实现。
 */
export type ProviderFormat = "openai-chat" | "openai-response" | "anthropic-message";

export const PROVIDER_FORMATS: readonly ProviderFormat[] = [
  "openai-chat",
  "openai-response",
  "anthropic-message",
];

export const PROVIDER_FORMAT_LABELS: Record<ProviderFormat, string> = {
  "openai-chat": "OpenAI Chat",
  "openai-response": "OpenAI Response",
  "anthropic-message": "Anthropic Message",
};

export function isProviderFormat(value: unknown): value is ProviderFormat {
  return PROVIDER_FORMATS.includes(value as ProviderFormat);
}
