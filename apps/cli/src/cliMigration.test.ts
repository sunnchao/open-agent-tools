import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleCommand, type CliContext } from "./commands/commands.ts";
import { toolLabel } from "./ui/cliUi.ts";
import { SYSTEM_PROMPT } from "./prompt/systemPrompt.ts";

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
      const context: CliContext = {
        currentSession: null,
        messages: [],
        allTools: [],
        projectContext: null,
        mcpToolServers: new Map(),
        rebuildTools: async () => {},
        mcpCleanup: async () => {},
        memoryStore: {} as CliContext["memoryStore"],
        ask: async () => "",
      };
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
});
