import chalk from "chalk";
import ora from "ora";
import type { ToolCallLike } from "../store/messages.ts";
import { resetMarkdownStream, renderMarkdownStream } from "./markdown.ts";
import { createClearRenderedLinesSequence, formatTokens } from "./terminal.ts";
import { addMessage, addSessionUsage, logAudit } from "../store/db.ts";
import type { PermissionManager } from "../tools/permissions.ts";
import type { CliContext } from "../commands/commands.ts";
import { toolLabel } from "./cliUi.ts";

/** 一轮对话的 token 用量汇总（原 deepagent 的 TokenUsage）。 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

/** Agent 回调契约（原 deepagent 的 AgentCallbacks，自建以解耦底座）。 */
export interface AgentCallbacks {
  onToken?: (text: string) => void;
  onReasoning?: (text: string) => void;
  onUsage?: (usage: TokenUsage) => void;
  onToolCall?: (tc: ToolCallLike) => void;
  onToolStart?: (tc: ToolCallLike) => void;
  onToolResult?: (tc: ToolCallLike, resultText: string) => void;
  onToolDenied?: (tc: ToolCallLike) => void;
  requestPermission?: (name: string, args: string) => Promise<boolean>;
  onAudit?: (entry: {
    source: "builtin" | "mcp";
    server?: string | null;
    toolName: string;
    decision: "allowed" | "denied" | "auto";
    argsSummary: string;
    error?: string | null;
  }) => void;
}

export interface AgentCallbacksDeps {
  cli: CliContext;
  permissionManager: PermissionManager;
  /** 当前模型名，用于 usage 展示。 */
  modelName?: string;
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
  const { cli, permissionManager, modelName } = deps;
  // 当前已渲染的 markdown 行数（用于流式重绘时把光标移回起点，避免重复滚动）。
  let renderedLineCount = 0;
  // 推理（think）内容的独立渲染状态：轻量纯文本通道，与主回答的 markdown 状态机隔离。
  // 推理片段仅在流式过程中可见，正式内容/工具调用开始即清行并落库。
  let reasoningText = "";
  let reasoningStarted = false;
  let renderedReasoningLineCount = 0;
  const spinner = ora({ text: "思考中…" });

  const stopSpinner = (): void => {
    if (spinner.isSpinning) spinner.stop();
  };

  const startSpinner = (text: string): void => {
    spinner.text = text;
    if (!spinner.isSpinning) spinner.start();
  };

  /** 把已累积的推理内容写入会话数据库（role=reasoning，作为上下文存储，不注入模型回传）。 */
  const flushReasoning = (): void => {
    if (reasoningText && cli.currentSession) {
      addMessage(cli.currentSession.id, {
        role: "reasoning",
        content: reasoningText,
        status: "complete",
      });
    }
    reasoningText = "";
  };

  /** 推理结束：清掉屏幕上已渲染的推理行并落库（正式内容或工具调用开始时调用，幂等）。 */
  const finishReasoning = (): void => {
    if (renderedReasoningLineCount > 0) {
      process.stdout.write(createClearRenderedLinesSequence(renderedReasoningLineCount));
      renderedReasoningLineCount = 0;
    }
    reasoningStarted = false;
    flushReasoning();
  };

  const resetStream = (): void => {
    stopSpinner();
    finishReasoning();
    resetMarkdownStream();
    renderedLineCount = 0;
  };

  return {
    resetStream,
    startActivity: () => startSpinner("思考中…"),
    stopActivity: stopSpinner,
    onReasoning: (text) => {
      stopSpinner();
      reasoningText += text;
      if (!reasoningStarted) {
        process.stdout.write(chalk.gray.italic("💭 "));
        reasoningStarted = true;
      }
      process.stdout.write(chalk.gray.italic(text));
      renderedReasoningLineCount = reasoningText.split("\n").length;
    },
    onToken: (text) => {
      stopSpinner();
      // 推理结束，正式内容开始：清掉推理行并落库
      finishReasoning();
      const rendered = renderMarkdownStream(text);
      if (!rendered) return;
      if (renderedLineCount > 0) {
        process.stdout.write(createClearRenderedLinesSequence(renderedLineCount));
      }
      process.stdout.write(rendered);
      renderedLineCount = rendered.split("\n").length;
    },
    onUsage: (usage) => {
      stopSpinner();
      process.stdout.write("\n");
      const reasoning =
        usage.reasoningTokens > 0 ? ` · 推理 ${formatTokens(usage.reasoningTokens)}` : "";
      const model = modelName ? ` · ${modelName}` : "";
      console.log(
        chalk.dim(
          `⇅ 输入 ${formatTokens(usage.inputTokens)} · 输出 ${formatTokens(usage.outputTokens)}${reasoning} tokens${model}`,
        ),
      );
      if (cli.currentSession) {
        addSessionUsage(cli.currentSession.id, usage);
      }
    },
    onToolCall: (tc: ToolCallLike) => {
      finishReasoning();
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
