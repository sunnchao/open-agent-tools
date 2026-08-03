/** 有风险、运行前需要用户授权的中断工具（deepagents 内置新工具名）。 */
export const DANGEROUS_TOOLS = new Set<string>(["write_file", "edit_file", "execute"]);

export const DEEPAGENT_BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set([
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

export function isDangerous(name: string): boolean {
  return DANGEROUS_TOOLS.has(name);
}
