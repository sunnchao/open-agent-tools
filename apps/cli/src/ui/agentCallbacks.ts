import chalk from "chalk";
import ora from "ora";
import type { AgentCallbacks, ToolCallLike } from "@open-agent-tools/deepagent";
import { resetMarkdownStream, renderMarkdownStream } from "./markdown.ts";
import { createClearRenderedLinesSequence } from "./terminal.ts";
import { addMessage, logAudit } from "../store/db.ts";
import type { PermissionManager } from "../tools/permissions.ts";
import type { CliContext } from "../commands/commands.ts";
import { toolLabel } from "./cliUi.ts";

export interface AgentCallbacksDeps {
  cli: CliContext;
  permissionManager: PermissionManager;
}

export interface StreamableAgentCallbacks extends AgentCallbacks {
  /** 每轮用户消息发送前重置流式 markdown 状态。 */
  resetStream: () => void;
  /** 发送消息后启动「思考中」spinner。 */
  startActivity: () => void;
  /** 停止 spinner（所有路径都必须调用）。 */
  stopActivity: () => void;
}

/**
 * 创建 Agent 回调：流式 markdown 重绘、工具事件打印、授权与审计持久化。
 * 行计数状态封装在闭包内，避免污染入口模块。
 */
export function createAgentCallbacks(deps: AgentCallbacksDeps): StreamableAgentCallbacks {
  const { cli, permissionManager } = deps;
  // 当前已渲染的 markdown 行数（用于流式重绘时把光标移回起点，避免重复滚动）。
  let renderedLineCount = 0;
  const spinner = ora({ text: "思考中…" });

  const stopSpinner = (): void => {
    if (spinner.isSpinning) spinner.stop();
  };

  const startSpinner = (text: string): void => {
    spinner.text = text;
    if (!spinner.isSpinning) spinner.start();
  };

  const resetStream = (): void => {
    stopSpinner();
    resetMarkdownStream();
    renderedLineCount = 0;
  };

  return {
    resetStream,
    startActivity: () => startSpinner("思考中…"),
    stopActivity: stopSpinner,
    onToken: (text) => {
      stopSpinner();
      const rendered = renderMarkdownStream(text);
      if (!rendered) return;
      if (renderedLineCount > 0) {
        process.stdout.write(createClearRenderedLinesSequence(renderedLineCount));
      }
      process.stdout.write(rendered);
      renderedLineCount = rendered.split("\n").length;
    },
    onToolCall: (tc: ToolCallLike) => {
      if (renderedLineCount > 0) process.stdout.write("\n");
      resetStream();
      const label = toolLabel(tc.name ?? "", tc.args);
      console.log(chalk.cyan.bold(`⏺ ${tc.name}`) + (label ? chalk.dim(` ${label}`) : ""));
    },
    onToolStart: (tc: ToolCallLike) => {
      resetStream();
      startSpinner(`正在执行 ${tc.name ?? "工具"}…`);
    },
    onToolResult: (tc: ToolCallLike, resultText: string) => {
      stopSpinner();
      if (cli.currentSession) {
        addMessage(cli.currentSession.id, {
          role: "tool",
          content: resultText,
          tool_call_id: tc.id || "",
          tool_name: tc.name || "",
          status: resultText.includes('"error"') ? "error" : "complete",
        });
      }
      console.log(chalk.dim(`   ✓ ${resultText.length} 字符`));
      startSpinner("思考中…");
    },
    onToolDenied: (tc: ToolCallLike) => {
      stopSpinner();
      console.log(chalk.red(`   ✗ 已拒绝: ${tc.name}`));
      startSpinner("思考中…");
    },
    requestPermission: (name, args) => permissionManager.decide(name, args),
    onAudit: (entry) => {
      logAudit({ ...entry, sessionId: cli.currentSession?.id ?? null });
    },
  };
}
