import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  filterSlashCommands,
  handleCommand,
  SLASH_COMMANDS,
  type CliContext,
} from "./commands/commands.ts";
import { toolLabel } from "./ui/cliUi.ts";
import { SYSTEM_PROMPT } from "./prompt/systemPrompt.ts";
import { addMessage, closeDb, createSession } from "./store/db.ts";

function makeContext(overrides?: Partial<CliContext>): CliContext {
  return {
    currentSession: null,
    messages: [],
    projectContext: null,
    mcpToolServers: new Map(),
    rebuildTools: async () => {},
    mcpCleanup: async () => {},
    memoryStore: {} as CliContext["memoryStore"],
    ask: async () => "",
    ...overrides,
  };
}

describe("CLI Pi 底座命令层", () => {
  it("系统提示词只引用 Pi 工具名", () => {
    assert.match(SYSTEM_PROMPT, /read/);
    assert.match(SYSTEM_PROMPT, /edit/);
    assert.match(SYSTEM_PROMPT, /bash/);
    assert.doesNotMatch(SYSTEM_PROMPT, /read_file|write_file|edit_file|execute|glob/);
  });

  it("toolLabel 提取 Pi 工具参数", () => {
    assert.equal(toolLabel("read", { path: "src/index.ts" }), "src/index.ts");
    assert.equal(toolLabel("ls", { path: "src" }), "src");
    assert.equal(toolLabel("grep", { pattern: "Agent" }), 'pattern="Agent"');
    assert.equal(toolLabel("bash", { command: "pnpm test" }), "pnpm test");
    assert.equal(toolLabel("memory_propose", { slug: "user-lang" }), "user-lang");
  });

  it("/tools 显示 Pi 内置工具与危险标记", async () => {
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    try {
      const context = makeContext({
        allToolNames: [
          "read",
          "write",
          "edit",
          "bash",
          "grep",
          "ls",
          "find",
          "task",
          "get_current_time",
        ],
      });
      const handled = await handleCommand("/tools", context);
      const output = lines.join("\n");

      assert.equal(handled, true);
      assert.match(output, /read/);
      assert.match(output, /write.*\[需授权\]/);
      assert.match(output, /bash.*\[需授权\]/);
      assert.match(output, /get_current_time/);
      assert.match(output, /task/);
      assert.doesNotMatch(output, /read_file|write_todos|\(deepagents\)/);
    } finally {
      console.log = originalLog;
    }
  });

  it("filterSlashCommands 按前缀过滤菜单候选", () => {
    assert.equal(filterSlashCommands("/").length, SLASH_COMMANDS.length);
    assert.equal(filterSlashCommands("").length, SLASH_COMMANDS.length);

    const help = filterSlashCommands("/he");
    assert.ok(help.some((c) => c.name === "/help"));
    assert.ok(
      help.every(
        (c) => c.name.includes("he") || c.description.includes("帮助") || c.name === "/help",
      ),
    );

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
              tool_name: "read",
            },
            { id: "4", role: "assistant", content: "这是一个很长的最终回复内容", createdAt: 3 },
          ],
        },
        messages: [
          { role: "user", content: "hi" },
          { role: "tool", content: "result", toolCallId: "tc1", toolName: "read" },
          { role: "assistant", content: "这是一个很长的最终回复内容" },
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

  it("/new 和 /load 会替换 Pi 会话历史", async () => {
    const root = await mkdtemp(join(tmpdir(), "cli-command-session-"));
    const previous = process.env.SQLITE_PATH;
    process.env.SQLITE_PATH = join(root, "chat.sqlite");
    try {
      const target = createSession({ id: "load-target", title: "目标会话" });
      addMessage(target.id, { role: "user", content: "我叫阿旺" });
      addMessage(target.id, { role: "assistant", content: "你好，阿旺" });
      const histories: CliContext["messages"][] = [];
      const context = makeContext({
        messages: [{ role: "user", content: "旧上下文" }],
        setAgentHistory: async (messages) => {
          histories.push(messages.map((message) => ({ ...message })));
        },
      });

      assert.equal(await handleCommand("/new", context), true);
      assert.deepEqual(context.messages, []);
      assert.deepEqual(histories, [[]]);

      assert.equal(await handleCommand(`/load ${target.id}`, context), true);
      assert.equal(context.currentSession?.id, target.id);
      assert.deepEqual(context.messages, [
        { role: "user", content: "我叫阿旺" },
        { role: "assistant", content: "你好，阿旺" },
      ]);
      assert.deepEqual(histories.at(-1), context.messages);
    } finally {
      closeDb();
      if (previous === undefined) delete process.env.SQLITE_PATH;
      else process.env.SQLITE_PATH = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("/mcp trust 等待信任写入和工具重建", async () => {
    const trusted: string[] = [];
    let rebuilds = 0;
    const context = makeContext({
      rebuildTools: async () => {
        await Promise.resolve();
        rebuilds += 1;
      },
      mcpServices: {
        listServers: () => [{ name: "fixture", trust: "confirm" }],
        store: {
          isTrusted: () => false,
          markAlways: (name) => trusted.push(name),
          untrust: () => {},
        },
      },
    });

    assert.equal(await handleCommand("/mcp trust fixture", context), true);
    assert.deepEqual(trusted, ["fixture"]);
    assert.equal(rebuilds, 1);
  });
});
