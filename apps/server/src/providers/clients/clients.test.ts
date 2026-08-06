import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProviderWithKey } from "../store.js";
import { createLlmClient } from "./index.js";
import { OpenAIChatClient } from "./openai-chat.js";
import { OpenAIResponseClient, toResponseInput } from "./openai-response.js";
import { AnthropicMessageClient, messagesEndpoint, toAnthropicPayload } from "./anthropic-message.js";
import type { LlmMessage } from "./types.js";

function makeProvider(overrides: Partial<ProviderWithKey>): ProviderWithKey {
  return {
    id: "p1",
    name: "Test",
    baseUrl: "https://example.com/v1",
    models: ["m1"],
    enabled: true,
    isDefault: false,
    apiKeyMasked: "sk***",
    apiKey: "sk-test",
    format: "openai-chat",
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

describe("createLlmClient", () => {
  it("dispatches to the client matching the provider format", () => {
    assert.ok(createLlmClient(makeProvider({ format: "openai-chat" })) instanceof OpenAIChatClient);
    assert.ok(
      createLlmClient(makeProvider({ format: "openai-response" })) instanceof OpenAIResponseClient,
    );
    assert.ok(
      createLlmClient(makeProvider({ format: "anthropic-message" })) instanceof AnthropicMessageClient,
    );
  });
});

describe("OpenAI Responses input mapping", () => {
  it("merges system into instructions and maps tool calls", () => {
    const messages: LlmMessage[] = [
      { role: "system", content: "You are a bot" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", name: "get_weather", arguments: '{"city":"SF"}' }],
      },
      { role: "tool", tool_call_id: "call_1", content: "72°F" },
      { role: "user", content: "thanks" },
    ];
    const { instructions, input } = toResponseInput(messages);
    assert.equal(instructions, "You are a bot");
    assert.equal(input.length, 5);
    assert.deepEqual(input[0], { role: "user", content: "hi" });
    assert.deepEqual(input[1], { role: "assistant", content: "" });
    assert.deepEqual(input[2], {
      type: "function_call",
      call_id: "call_1",
      name: "get_weather",
      arguments: '{"city":"SF"}',
    });
    assert.deepEqual(input[3], { type: "function_call_output", call_id: "call_1", output: "72°F" });
    assert.deepEqual(input[4], { role: "user", content: "thanks" });
  });
});

describe("Anthropic Messages payload mapping", () => {
  it("merges consecutive tool results into one user message", () => {
    const messages: LlmMessage[] = [
      { role: "system", content: "You are a bot" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "toolu_1", name: "a", arguments: "{}" },
          { id: "toolu_2", name: "b", arguments: "{}" },
        ],
      },
      { role: "tool", tool_call_id: "toolu_1", content: "r1" },
      { role: "tool", tool_call_id: "toolu_2", content: "r2" },
      { role: "user", content: "next" },
    ];
    const { system, body } = toAnthropicPayload(messages, undefined, "claude-3-5-sonnet", false);
    assert.equal(system, "You are a bot");
    assert.equal(body.model, "claude-3-5-sonnet");
    const { messages: mapped } = body as { messages: Array<{ role: string; content: unknown[] }> };
    // [user(hi), assistant(tool_use×2), user(tool_result×2 + next)] —— 连续 user 块合并
    assert.equal(mapped.length, 3);
    assert.equal(mapped[0]!.role, "user");
    assert.equal(mapped[1]!.role, "assistant");
    const assistantContent = mapped[1]!.content as Array<{ type: string }>;
    assert.equal(assistantContent.length, 2);
    assert.equal(assistantContent[0]!.type, "tool_use");
    const mergedUserContent = mapped[2]!.content as Array<{ type: string }>;
    assert.equal(mergedUserContent.length, 3);
    assert.equal(mergedUserContent[0]!.type, "tool_result");
    assert.equal(mergedUserContent[1]!.type, "tool_result");
    assert.equal(mergedUserContent[2]!.type, "text");
  });

  it("normalizes the baseUrl to the /v1/messages endpoint", () => {
    assert.equal(messagesEndpoint("https://api.anthropic.com"), "https://api.anthropic.com/v1/messages");
    assert.equal(
      messagesEndpoint("https://api.anthropic.com/v1"),
      "https://api.anthropic.com/v1/messages",
    );
    assert.equal(
      messagesEndpoint("https://gateway.example.com/proxy/"),
      "https://gateway.example.com/proxy/v1/messages",
    );
  });

  it("maps tools to input_schema", () => {
    const { body } = toAnthropicPayload(
      [{ role: "user", content: "hi" }],
      [
        { name: "f", description: "desc", parameters: { type: "object" } },
      ],
      "claude",
      false,
    );
    const { tools } = body as { tools: Array<{ name: string; input_schema: unknown }> };
    assert.deepEqual(tools, [
      { name: "f", description: "desc", input_schema: { type: "object" } },
    ]);
  });
});
