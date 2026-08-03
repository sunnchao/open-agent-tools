import type { StructuredToolInterface } from "@langchain/core/tools";
import { getCurrentTime } from "./time.ts";

/**
 * 内置自定义工具（不含 deepagents 提供的 fs/shell/todo/task 内置工具，
 * 不含 MCP 动态加载工具）。记忆工具由 Task 5 加入。
 */
export function getBuiltinTools(): StructuredToolInterface[] {
  return [getCurrentTime];
}
