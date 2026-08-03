import readline from "node:readline";
import { listConfiguredServers, trustStore } from "@open-agent-tools/deepagent";
import chalk from "chalk";
import type { PermissionDecision } from "../tools/permissions.ts";
import type { Session } from "../store/db.ts";
import { createClearRenderedLinesSequence } from "./terminal.ts";
import { createLineInput, openKeypress, triggerSigint, type KeypressKey } from "./keyboard.ts";

/** 把 question 包成 Promise，支持方向键编辑与历史导航。 */
export function createAsk(rl: readline.Interface): (question: string) => Promise<string> {
  const input = createLineInput(rl);
  return (question) => input(question);
}

/**
 * 交互式菜单选择：用 ↑/↓ 上下切换、Enter 确认，不依赖输入文字。
 * 选择完成后恢复行模式，避免影响后续行输入。
 */
export function createMenuSelect(
  rl: readline.Interface,
): (title: string, options: string[]) => Promise<number> {
  return (title, options) =>
    new Promise((resolve) => {
      let index = 0;
      // 当前已输出的行数（按 \n 拆分后的行数）
      let renderedLines = 0;
      let close: () => void = () => {};

      const clear = (): void => {
        if (renderedLines > 0) {
          process.stdout.write(createClearRenderedLinesSequence(renderedLines));
          renderedLines = 0;
        }
      };

      const render = (): void => {
        clear();
        // 选项行用 2 空格对齐，高亮行前缀用 ▸ 替换首字符，宽度一致不抖动
        const lines = [
          title,
          ...options.map((label, i) =>
            i === index ? chalk.bold.cyan(`▸ ${label}`) : chalk.dim(`  ${label}`),
          ),
        ];
        const text = lines.join("\n");
        process.stdout.write(text);
        renderedLines = lines.length;
      };

      const finish = (): void => {
        close();
        clear();
      };

      const onKey = (_s: string, key: KeypressKey): void => {
        if (key.name === "up" || key.sequence === "\x1b[A") {
          index = index === 0 ? options.length - 1 : index - 1;
          render();
        } else if (key.name === "down" || key.sequence === "\x1b[B") {
          index = index === options.length - 1 ? 0 : index + 1;
          render();
        } else if (key.name === "return" || key.sequence === "\r" || key.sequence === "\n") {
          finish();
          resolve(index);
        } else if (key.ctrl && key.name === "c") {
          triggerSigint(finish);
        }
      };

      close = openKeypress(rl, onKey);
      render();
    });
}

/** 危险工具权限确认：菜单上下切换选择，不依赖输入文字。 */
export function createConfirm(
  rl: readline.Interface,
): (name: string, args: string) => Promise<PermissionDecision> {
  const select = createMenuSelect(rl);
  return (name: string, args: string) => {
    const preview = args.length > 160 ? `${args.slice(0, 160)}…` : args;
    // 标题不带前置换行：渲染时已从当前光标位置开始，避免额外空行
    const title =
      chalk.yellow(`⚠ 允许运行工具 ${chalk.bold(name)} ${chalk.dim(preview)}`) +
      chalk.gray("（↑/↓ 切换，Enter 确认）");

    return select(title, ["允许", "拒绝", "始终允许"]).then((i) => {
      if (i === 2) return "always";
      if (i === 0) return "allow";
      return "deny";
    });
  };
}

/** 启动前交互式信任确认：未信任的 server 必须显式信任，否则不会静默加载。 */
export async function promptForTrust(rl: readline.Interface): Promise<void> {
  const select = createMenuSelect(rl);
  const pending = listConfiguredServers().filter(
    (s) => s.trust !== "trusted" && !trustStore.isTrusted(s.name),
  );
  for (const s of pending) {
    const i = await select(chalk.yellow(`⚠ 是否信任 MCP server ${chalk.bold(s.name)}？`), [
      "本次会话信任",
      "始终信任",
      "拒绝",
    ]);
    if (i === 1) {
      trustStore.markAlways(s.name);
      console.log(chalk.green(`✓ 已信任并记住: ${s.name}`));
    } else if (i === 0) {
      trustStore.markSession(s.name);
      console.log(chalk.green(`✓ 本次会话信任: ${s.name}`));
    } else {
      console.log(chalk.dim(`✗ 已拒绝: ${s.name}`));
    }
  }
}

/** 从工具参数里提取一个「主语标签」，让工具调用行更具可读性。 */
export function toolLabel(name: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (name) {
    case "read_file":
    case "write_file":
    case "edit_file":
      return typeof a.file_path === "string" ? a.file_path : "";
    case "ls":
      return typeof a.path === "string" ? a.path : ".";
    case "glob":
    case "grep":
      return typeof a.pattern === "string" ? `pattern="${a.pattern}"` : "";
    case "execute":
      return typeof a.command === "string" ? a.command.slice(0, 80) : "";
    case "write_todos": {
      const todos = typeof a.todos === "string" ? a.todos : JSON.stringify(a.todos ?? "");
      return todos.slice(0, 80);
    }
    default:
      return "";
  }
}

/** 主循环提示符。 */
export function getPrompt(currentSession: Session | null): string {
  return currentSession
    ? chalk.bold.green(`[${currentSession.id.slice(0, 8)}] ▸ `)
    : chalk.bold.green("▸ ");
}
