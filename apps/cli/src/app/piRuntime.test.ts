import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attachSessionCallbacks,
  assistantText,
  lastAssistantText,
  argsSummary,
  completeToolAudit,
  handleToolCallEvent,
  BUILTIN_TOOLS,
  HITL_TOOLS,
  PI_COMPACTION_SETTINGS,
  PI_MODEL_CONTEXT_WINDOW,
} from "./piRuntime.ts";
import { shouldCompact } from "@earendil-works/pi-coding-agent";
import type {
  AgentSessionEvent,
  AgentSessionEventListener,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import type { StreamableAgentCallbacks } from "../ui/agentCallbacks.ts";

function callbacks(overrides: Partial<StreamableAgentCallbacks> = {}): StreamableAgentCallbacks {
  return {
    resetStream: () => {},
    startActivity: () => {},
    stopActivity: () => {},
    ...overrides,
  };
}

test("assistantText 拼接 text block、忽略 toolCall/thinking", () => {
  assert.equal(
    assistantText([
      { type: "text", text: "你好" },
      { type: "thinking", thinking: "思考" },
      { type: "toolCall", id: "c1", name: "ls", arguments: {} },
      { type: "text", text: "，世界" },
    ]),
    "你好，世界",
  );
});

test("assistantText 对非数组 / 空返回空串", () => {
  assert.equal(assistantText(undefined), "");
  assert.equal(assistantText("plain string"), "");
  assert.equal(assistantText([]), "");
});

test("lastAssistantText 取最后一个含文本的 assistant 消息", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "text", text: "first" }] },
    { role: "assistant", content: [{ type: "toolCall", id: "c", name: "bash", arguments: {} }] },
    { role: "assistant", content: [{ type: "text", text: "final" }] },
  ];
  assert.equal(lastAssistantText(messages), "final");
});

test("lastAssistantText 跳过空 assistant、无文本返回空串", () => {
  assert.equal(
    lastAssistantText([
      { role: "assistant", content: [] },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]),
    "",
  );
});

test("argsSummary 序列化参数", () => {
  assert.equal(argsSummary({ command: "ls" }), '{"command":"ls"}');
  assert.equal(argsSummary({}), "{}");
});

test("completeToolAudit 记录成功和失败结果", () => {
  const entry = {
    source: "builtin" as const,
    server: null,
    toolName: "bash",
    decision: "allowed" as const,
    argsSummary: '{"command":"false"}',
  };
  assert.deepEqual(completeToolAudit(entry, { content: [] }, false), { ...entry, error: null });
  assert.deepEqual(
    completeToolAudit(
      entry,
      { content: [{ type: "text", text: "command exited with status 1" }] },
      true,
    ),
    { ...entry, error: "command exited with status 1" },
  );
});

test("HITL_TOOLS 覆盖写/编辑/执行三类危险工具", () => {
  for (const name of ["write", "edit", "bash"]) {
    assert.ok(HITL_TOOLS.has(name), `${name} 应在 HITL 集合`);
  }
  assert.ok(!HITL_TOOLS.has("read"), "read 不应在 HITL 集合");
});

test("BUILTIN_TOOLS 包含 Pi 内置读写与读类工具", () => {
  for (const name of ["read", "write", "edit", "bash", "grep", "ls", "find"]) {
    assert.ok(BUILTIN_TOOLS.includes(name), `${name} 应在内置工具白名单`);
  }
});

test("compaction 在 128k 窗口预留 10k 后越过阈值触发", () => {
  const threshold = PI_MODEL_CONTEXT_WINDOW - PI_COMPACTION_SETTINGS.reserveTokens;
  assert.equal(threshold, 118_000);
  assert.equal(shouldCompact(threshold, PI_MODEL_CONTEXT_WINDOW, PI_COMPACTION_SETTINGS), false);
  assert.equal(shouldCompact(threshold + 1, PI_MODEL_CONTEXT_WINDOW, PI_COMPACTION_SETTINGS), true);
});

test("attachSessionCallbacks 桥接 text_delta 与 thinking_delta", () => {
  let listener: AgentSessionEventListener | undefined;
  const text: string[] = [];
  const reasoning: string[] = [];
  const active = callbacks({
    onToken: (delta) => text.push(delta),
    onReasoning: (delta) => reasoning.push(delta),
  });
  attachSessionCallbacks(
    {
      subscribe(next) {
        listener = next;
        return () => {};
      },
    },
    () => active,
  );

  listener?.({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "你好" },
  } as AgentSessionEvent);
  listener?.({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta: "思考" },
  } as AgentSessionEvent);

  assert.deepEqual(text, ["你好"]);
  assert.deepEqual(reasoning, ["思考"]);
});

test("handleToolCallEvent 对危险工具默认拒绝并记录审计", async () => {
  const denied: string[] = [];
  const audits: Array<{ decision: string; argsSummary: string }> = [];
  const event = {
    type: "tool_call",
    toolName: "bash",
    toolCallId: "call-1",
    input: { command: "pwd" },
  } as ToolCallEvent;

  const result = await handleToolCallEvent(event, {
    callbacks: callbacks({ onToolDenied: (call) => denied.push(call.name ?? "") }),
    mcpToolNames: [],
    onAudit: (entry) => audits.push(entry),
  });

  assert.equal(result?.block, true);
  assert.equal((event.input as { timeout?: number }).timeout, 30);
  assert.deepEqual(denied, ["bash"]);
  assert.deepEqual(audits, [
    {
      source: "builtin",
      server: null,
      toolName: "bash",
      decision: "denied",
      argsSummary: '{"command":"pwd","timeout":30}',
    },
  ]);
});

test("handleToolCallEvent 放行已授权危险工具", async () => {
  const started: string[] = [];
  const audits: string[] = [];
  const result = await handleToolCallEvent(
    {
      type: "tool_call",
      toolName: "write",
      toolCallId: "call-2",
      input: { path: "a.txt", content: "ok" },
    } as ToolCallEvent,
    {
      callbacks: callbacks({
        requestPermission: async () => true,
        onToolStart: (call) => started.push(call.name ?? ""),
      }),
      mcpToolNames: [],
      onAudit: (entry) => audits.push(entry.decision),
    },
  );

  assert.equal(result, undefined);
  assert.deepEqual(started, ["write"]);
  assert.deepEqual(audits, ["allowed"]);
});
