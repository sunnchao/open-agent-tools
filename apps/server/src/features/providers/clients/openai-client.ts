import { OpenAI } from "openai";
import type { ProviderWithKey } from "../store.js";

export function createOpenAIClient(provider: ProviderWithKey): OpenAI {
  return new OpenAI({
    apiKey: provider.apiKey ?? "",
    baseURL: provider.baseUrl,
  });
}
