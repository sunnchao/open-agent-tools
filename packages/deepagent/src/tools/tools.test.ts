import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  Agent,
  DEEPAGENT_BUILTIN_TOOL_NAMES,
  DANGEROUS_TOOLS,
  LocalShellBackend,
  getBuiltinTools,
  isDangerous,
  loadMcpTools,
} from "../index.ts";
import { getCurrentTime } from "./time.ts";
import { extractText, isAllowedByAcl, type McpServerConfig } from "./mcp.ts";

const cfg = (partial: Partial<McpServerConfig>): McpServerConfig => ({
  name: "s",
  transport: "stdio",
  command: "echo",
  ...partial,
});

describe("package root API", () => {
  it("导出 CLI 消费的 Agent、backend 与工具 API", () => {
    assert.equal(typeof Agent, "function");
    assert.equal(typeof LocalShellBackend, "function");
    assert.equal(typeof getBuiltinTools, "function");
    assert.equal(typeof loadMcpTools, "function");
    assert.equal(typeof isDangerous, "function");
    assert.ok(DEEPAGENT_BUILTIN_TOOL_NAMES instanceof Set);
  });

  it("自定义内置工具只包含 getCurrentTime", () => {
    assert.deepEqual(
      getBuiltinTools().map((tool) => tool.name),
      ["getCurrentTime"],
    );
  });

  it("危险工具名严格匹配 Deep Agents 写入与执行工具", () => {
    assert.deepEqual([...DANGEROUS_TOOLS], ["write_file", "edit_file", "execute"]);
  });

  it("保留全部 Deep Agents 内置工具名", () => {
    assert.deepEqual([...DEEPAGENT_BUILTIN_TOOL_NAMES], [
      "ls",
      "read_file",
      "write_file",
      "edit_file",
      "glob",
      "grep",
      "execute",
      "task",
      "write_todos",
      "start_async_task",
      "check_async_task",
      "update_async_task",
      "cancel_async_task",
      "list_async_tasks",
    ]);
  });
});

describe("tools/time", () => {
  it("getCurrentTime 返回可解析的 ISO 8601 时间", async () => {
    const raw = await getCurrentTime.invoke({});
    const parsed = JSON.parse(raw) as { time: string };
    assert.ok(!Number.isNaN(Date.parse(parsed.time)));
  });
});

describe("tools/mcp 纯函数", () => {
  it("deniedTools 优先于 allowedTools", () => {
    const c = cfg({ deniedTools: ["danger"], allowedTools: ["danger", "ok"] });
    assert.equal(isAllowedByAcl(c, "danger"), false);
  });

  it("allowedTools 白名单过滤", () => {
    assert.equal(isAllowedByAcl(cfg({ allowedTools: ["ok"] }), "other"), false);
    assert.equal(isAllowedByAcl(cfg({ allowedTools: ["ok"] }), "ok"), true);
  });

  it("无 ACL 时全部放行", () => {
    assert.equal(isAllowedByAcl(cfg({}), "anything"), true);
  });

  it("extractText 提取 text 内容并忽略其它类型", () => {
    assert.equal(
      extractText([
        { type: "text", text: "a" },
        { type: "image", data: "x" },
        { type: "text", text: "b" },
      ]),
      "a\nb",
    );
  });

  it("extractText 对非数组内容 JSON 序列化", () => {
    assert.equal(extractText("plain"), '"plain"');
    assert.equal(extractText(42), "42");
  });
});
