/**
 * P2.1 todo 工具（Pi defineTool 版）。
 *
 * 以项目根 `TODO.md` 作为任务清单（Pi 官方推荐的 TODO.md 约定）：
 * list / add / complete / clear。模型可直接结构化维护任务，文件可被
 * read/write 复用、可持久化到 git。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Type, StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

const TODO_ACTIONS = ["list", "add", "complete", "clear"] as const;

interface TodoItem {
  text: string;
  completed: boolean;
}

function readTodos(cwd: string): TodoItem[] {
  const p = join(cwd, "TODO.md");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8")
    .split("\n")
    .map((line): TodoItem | null => {
      const match = line.match(/^- \[([ xX])\]\s+(.+)$/);
      if (!match) return null;
      return {
        text: match[2]?.trim() ?? "",
        completed: (match[1] ?? "").toLowerCase() === "x",
      };
    })
    .filter((item): item is TodoItem => item !== null && item.text.length > 0);
}

function renderTodos(cwd: string, todos: TodoItem[]): void {
  const header = "# TODO\n\n";
  const body = todos.map((todo) => `- [${todo.completed ? "x" : " "}] ${todo.text}`).join("\n");
  writeFileSync(join(cwd, "TODO.md"), `${header}${body}\n`, "utf-8");
}

export function createTodoPiTool(cwd: string): ToolDefinition {
  return defineTool({
    name: "todo",
    label: "任务清单",
    description:
      "管理项目根 TODO.md 任务清单（list / add / complete / clear）。多步任务先建清单，逐项完成并勾选。",
    parameters: Type.Object({
      action: StringEnum(TODO_ACTIONS, {
        description: "操作：list 查看；add 添加；complete 勾选完成；clear 清空未完成项",
      }),
      item: Type.Optional(
        Type.String({ description: "任务内容（add 必填；complete 填要勾选的项）" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const action = params.action;
      const todos = readTodos(cwd);
      let text = "";

      switch (action) {
        case "list":
          text =
            todos.length > 0
              ? todos.map((todo) => `- [${todo.completed ? "x" : " "}] ${todo.text}`).join("\n")
              : "（无待办）";
          break;
        case "add": {
          if (!params.item?.trim()) {
            return {
              content: [{ type: "text", text: JSON.stringify({ error: "add 需要 item 参数" }) }],
              details: {},
            };
          }
          todos.push({ text: params.item.trim(), completed: false });
          renderTodos(cwd, todos);
          text = `已添加: ${params.item.trim()}`;
          break;
        }
        case "complete": {
          if (!params.item?.trim()) {
            return {
              content: [
                { type: "text", text: JSON.stringify({ error: "complete 需要 item 参数" }) },
              ],
              details: {},
            };
          }
          const target = params.item.trim();
          const idx = todos.findIndex((todo) => todo.text === target && !todo.completed);
          if (idx < 0) {
            return {
              content: [{ type: "text", text: JSON.stringify({ error: `未找到待办: ${target}` }) }],
              details: {},
            };
          }
          const done = todos[idx]!;
          done.completed = true;
          renderTodos(cwd, todos);
          text = `已完成: ${done.text}`;
          break;
        }
        case "clear":
          renderTodos(
            cwd,
            todos.filter((todo) => todo.completed),
          );
          text = "已清空未完成项";
          break;
      }

      return { content: [{ type: "text", text }], details: {} };
    },
  });
}
