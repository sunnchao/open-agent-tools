import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTodoPiTool } from "./todoPi.ts";

interface TodoTool {
  execute(
    toolCallId: string,
    params: { action: "list" | "add" | "complete" | "clear"; item?: string },
  ): Promise<{ content: Array<{ type: string; text: string }> }>;
}

test("todo 工具保持标题与完成状态，并只清理未完成项", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "todo-pi-"));
  const tool = createTodoPiTool(cwd) as unknown as TodoTool;
  try {
    await tool.execute("1", { action: "add", item: "修复流式输出" });
    await tool.execute("2", { action: "complete", item: "修复流式输出" });
    await tool.execute("3", { action: "add", item: "补测试" });

    const listed = await tool.execute("4", { action: "list" });
    assert.equal(listed.content[0]?.text, "- [x] 修复流式输出\n- [ ] 补测试");
    assert.equal(
      await readFile(join(cwd, "TODO.md"), "utf8"),
      "# TODO\n\n- [x] 修复流式输出\n- [ ] 补测试\n",
    );

    await tool.execute("5", { action: "clear" });
    assert.equal(await readFile(join(cwd, "TODO.md"), "utf8"), "# TODO\n\n- [x] 修复流式输出\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
