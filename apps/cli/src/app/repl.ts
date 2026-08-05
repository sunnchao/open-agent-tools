import { HumanMessage } from "@langchain/core/messages";
import chalk from "chalk";
import { handleCommand } from "../commands/commands.ts";
import { createSlashCommandPicker, getPrompt } from "../ui/cliUi.ts";
import { createLineInput } from "../ui/keyboard.ts";
import { buildSystemPrompt } from "../prompt/prompt.ts";
import { createSession, addMessage } from "../store/db.ts";
import type { Runtime } from "./runtime.ts";

/** 主聊天循环（async 循环式，避免递归导致的 prompt 堆叠）。 */
export async function replLoop(runtime: Runtime): Promise<void> {
  const { rl, cli, memoryStore, callbacks } = runtime;
  const inputLine = createLineInput(rl);
  const pickSlashCommand = createSlashCommandPicker(rl);

  while (true) {
    const input = await inputLine(getPrompt(cli.currentSession));

    const trimmed = input.trim();

    if (trimmed.toLowerCase() === "exit") {
      console.log(chalk.dim("Goodbye!"));
      await cli.mcpCleanup().catch(() => {});
      memoryStore.close();
      rl.close();
      return;
    }

    // 斜杠命令：已知命令直接执行；输入 `/` 或未知前缀时打开 ↑/↓ 菜单
    if (trimmed.startsWith("/")) {
      const handled = trimmed !== "/" && (await handleCommand(input, cli));
      if (!handled) {
        const selected = await pickSlashCommand(trimmed);
        if (selected) await handleCommand(selected, cli);
      }
      continue;
    }

    if (!cli.currentSession) {
      cli.currentSession = createSession();
      console.log(chalk.dim(`自动创建新会话: ${cli.currentSession.id}`));
    }

    cli.messages.push(new HumanMessage(input));
    if (cli.currentSession) {
      addMessage(cli.currentSession.id, { role: "user", content: input, status: "complete" });
    }

    callbacks.resetStream();
    callbacks.startActivity();

    try {
      const answer = await runtime.agent.runTurn(
        cli.messages,
        buildSystemPrompt({
          projectContext: cli.projectContext,
          memoryStore,
          taskHint: input,
        }),
        callbacks,
      );
      // 流式渲染用 \x1b[2K\r 留在当前行，这里先换行再收尾空行，让 prompt 不重叠
      callbacks.stopActivity();
      process.stdout.write("\n");
      console.log();
      if (cli.currentSession) {
        addMessage(cli.currentSession.id, {
          role: "assistant",
          content: answer,
          status: "complete",
        });
      }
    } catch (error) {
      callbacks.stopActivity();
      console.error(chalk.red(`\n请求失败: ${error instanceof Error ? error.message : error}`));
    }
  }
}
