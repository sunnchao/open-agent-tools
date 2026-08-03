import chalk from "chalk";
import { loadEnv } from "./app/env.ts";
import { loadContextFile, CONTEXT_FILE_NAME } from "./store/context.ts";
import { openDb, getDbPath, listSessions } from "./store/db.ts";
import { promptForTrust } from "./ui/cliUi.ts";
import { createRuntime } from "./app/runtime.ts";
import { replLoop } from "./app/repl.ts";

loadEnv();

async function main(): Promise<void> {
  const runtime = await createRuntime();
  const { rl, cli, memoryStore } = runtime;

  openDb();
  memoryStore.open();
  console.log(chalk.dim(`数据库路径: ${getDbPath()}`));
  console.log(chalk.dim(`项目记忆: ${memoryStore.projectRoot}`));
  console.log(chalk.dim(`全局记忆: ${memoryStore.globalRoot}`));
  console.log(chalk.bold.cyan("\nopen-agent-tools · coding agent (agent 模式)"));
  console.log(
    chalk.dim("输入 /help 查看命令。危险工具（写文件/编辑/执行命令）运行前会请求授权。\n"),
  );

  await promptForTrust(rl);
  await runtime.rebuildTools();

  const existingCtx = loadContextFile(process.cwd());
  if (existingCtx) {
    cli.projectContext = existingCtx;
    console.log(
      chalk.dim(`已加载项目上下文: ${CONTEXT_FILE_NAME}（可用 /init 重新生成，/context 查看）\n`),
    );
  }

  const sessions = listSessions();
  if (sessions.length > 0) {
    console.log(chalk.dim(`找到 ${sessions.length} 个历史会话，使用 /list 查看\n`));
  }

  await replLoop(runtime);
}

void main();
