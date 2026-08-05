import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import {
  filterSlashCommands,
  handleCommand,
  SLASH_COMMANDS,
  type CliContext,
} from "./commands/commands.ts";
import { toolLabel } from "./ui/cliUi.ts";
import { SYSTEM_PROMPT } from "./prompt/systemPrompt.ts";

function makeContext(overrides?: Partial<CliContext>): CliContext {
  return {
    currentSession: null,
    messages: [],
    allTools: [],
    projectContext: null,
    mcpToolServers: new Map(),
    rebuildTools: async () => {},
    mcpCleanup: async () => {},
    memoryStore: {} as CliContext["memoryStore"],
    ask: async () => "",
    ...overrides,
  };
}

describe("Deep Agents CLI migration", () => {
  it("系统提示词只引用 Deep Agents 工具名", () => {
    assert.match(SYSTEM_PROMPT, /read_file/);
    assert.match(SYSTEM_PROMPT, /edit_file/);
    assert.match(SYSTEM_PROMPT, /execute/);
    assert.doesNotMatch(
      SYSTEM_PROMPT,
      /\b(?:listDirectory|readFile|grepFiles|writeFile|editFile|executeCommand)\b/,
    );
  });

  it("toolLabel 提取 Deep Agents 工具参数", () => {
    assert.equal(toolLabel("read_file", { file_path: "src/index.ts" }), "src/index.ts");
    assert.equal(toolLabel("ls", { path: "src" }), "src");
    assert.equal(toolLabel("grep", { pattern: "Agent" }), 'pattern="Agent"');
    assert.equal(toolLabel("execute", { command: "pnpm test" }), "pnpm test");
  });

  it("/tools 显示 Deep Agents 内置工具与危险标记", async () => {
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    try {
      const context = makeContext();
      const handled = await handleCommand("/tools", context);
      const output = lines.join("\n");

      assert.equal(handled, true);
      assert.match(output, /read_file/);
      assert.match(output, /write_file.*\[需授权\]/);
      assert.match(output, /execute.*\[需授权\]/);
      assert.match(output, /write_todos/);
      assert.match(output, /task/);
    } finally {
      console.log = originalLog;
    }
  });

  it("filterSlashCommands 按前缀过滤菜单候选", () => {
    assert.equal(filterSlashCommands("/").length, SLASH_COMMANDS.length);
    assert.equal(filterSlashCommands("").length, SLASH_COMMANDS.length);

    const help = filterSlashCommands("/he");
    assert.ok(help.some((c) => c.name === "/help"));
    assert.ok(help.every((c) => c.name.includes("he") || c.description.includes("帮助") || c.name === "/help"));

    const load = filterSlashCommands("/load");
    assert.equal(load.length, 1);
    assert.equal(load[0]?.name, "/load");
  });

  it("/info 完整展示会话 usage 与消息统计", async () => {
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    try {
      const context = makeContext({
        currentSession: {
          id: "sess-abc",
          title: "测试会话",
          updatedAt: 1700000000000,
          usage: { inputTokens: 1234, outputTokens: 4567, reasoningTokens: 300 },
          messages: [
            { id: "1", role: "user", content: "hi", createdAt: 0 },
            { id: "2", role: "reasoning", content: "think", createdAt: 1 },
            {
              id: "3",
              role: "tool",
              content: "result",
              createdAt: 2,
              tool_call_id: "tc1",
              tool_name: "read_file",
            },
            { id: "4", role: "assistant", content: "这是一个很长的最终回复内容", createdAt: 3 },
          ],
        },
        messages: [
          new HumanMessage("hi"),
          new ToolMessage({ content: "result", tool_call_id: "tc1" }),
          new AIMessage("这是一个很长的最终回复内容"),
        ],
      });
      const handled = await handleCommand("/info", context);
      const output = lines.join("\n");

      assert.equal(handled, true);
      // 会话基础信息
      assert.match(output, /sess-abc/);
      assert.match(output, /测试会话/);
      assert.match(output, /累计模型用量/);
      // token 展示（1.2k / 4.6k / 300）
      assert.match(output, /输入 1\.2k/);
      assert.match(output, /输出 4\.6k/);
      assert.match(output, /推理 300/);
      assert.match(output, /精确值: 1234 \/ 4567 \/ 300/);
      // 消息角色统计
      assert.match(output, /用户 1 · 助手 1 · 工具 1 · 推理 1/);
      // 最后回复预览
      assert.match(output, /最后回复/);
      assert.match(output, /最终回复内容/);
    } finally {
      console.log = originalLog;
    }
  });
});
