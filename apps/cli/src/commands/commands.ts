import {
  SystemMessage,
  HumanMessage,
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import {
  DEEPAGENT_BUILTIN_TOOL_NAMES,
  isDangerous,
  listConfiguredServers,
  trustStore,
} from "@open-agent-tools/deepagent";
import chalk from "chalk";
import {
  createSession,
  listSessions,
  getSession,
  deleteSession,
  listAudit,
  type Session,
} from "../store/db.ts";
import {
  generateProjectContext,
  contextToMarkdown,
  writeContextFile,
  CONTEXT_FILE_NAME,
} from "../store/context.ts";
import type { MemoryStore } from "../store/memory.ts";
import { handleMemoryCommand } from "./memoryCommands.ts";

/**
 * 跨命令共享的可变状态与依赖。
 * 把原本散落在 index.ts 顶层的模块级变量/函数收敛到这里，
 * 让 handleCommand 以纯参数方式接收，而不是捕获模块作用域闭包，便于测试与复用。
 */
export interface CliContext {
  currentSession: Session | null;
  messages: BaseMessage[];
  allTools: StructuredToolInterface[];
  projectContext: string | null;
  /** 工具名 → 所属 MCP server 名（内置工具不在其中）。 */
  mcpToolServers: Map<string, string>;
  /** 重新装配内置 + MCP 工具（/mcp 用）。 */
  rebuildTools: () => Promise<void>;
  /** 关闭 MCP 连接（/mcp 重新加载前调用）。 */
  mcpCleanup: () => Promise<void>;
  /** 长期记忆服务。 */
  memoryStore: MemoryStore;
  /** 复用主 readline 发起命令内交互，避免双 readline 回显。 */
  ask: (question: string) => Promise<string>;
}

/** 处理斜杠命令。返回 true 表示已处理（主循环无需再当作普通对话发给模型）。 */
export async function handleCommand(input: string, ctx: CliContext): Promise<boolean> {
  const trimmed = input.trim();

  if (await handleMemoryCommand(input, { store: ctx.memoryStore, ask: ctx.ask })) {
    return true;
  }

  if (trimmed === "/new") {
    ctx.currentSession = createSession();
    ctx.messages.length = 0;
    console.log(chalk.green(`✓ 新会话已创建: ${ctx.currentSession.id}`));
    return true;
  }

  if (trimmed === "/list") {
    const sessions = listSessions();
    if (sessions.length === 0) {
      console.log(chalk.dim("暂无会话"));
    } else {
      console.log(chalk.bold("\n历史会话:"));
      for (const s of sessions) {
        const prefix = ctx.currentSession?.id === s.id ? chalk.green("→") : " ";
        const date = new Date(s.updatedAt).toLocaleString("zh-CN");
        console.log(
          `${prefix} ${chalk.cyan(s.id.slice(0, 8))} ${s.title} ${chalk.dim(`(${date})`)}`,
        );
      }
      console.log();
    }
    return true;
  }

  if (trimmed.startsWith("/load ")) {
    const sessionId = trimmed.slice(6).trim();
    const session = getSession(sessionId);
    if (!session) {
      console.log(chalk.red(`✗ 会话不存在: ${sessionId}`));
      return true;
    }
    ctx.currentSession = session;
    ctx.messages.length = 0;
    for (const msg of session.messages) {
      if (msg.role === "user") ctx.messages.push(new HumanMessage(msg.content));
      else if (msg.role === "assistant") ctx.messages.push(new AIMessage(msg.content));
      else if (msg.role === "system") ctx.messages.push(new SystemMessage(msg.content));
      else if (msg.role === "tool") {
        ctx.messages.push(
          new ToolMessage({ content: msg.content, tool_call_id: msg.tool_call_id || "" }),
        );
      }
    }
    console.log(chalk.green(`✓ 已加载会话: ${session.title} (${session.messages.length} 条消息)`));
    return true;
  }

  if (trimmed.startsWith("/delete ")) {
    const sessionId = trimmed.slice(8).trim();
    const success = deleteSession(sessionId);
    if (!success) {
      console.log(chalk.red(`✗ 会话不存在: ${sessionId}`));
    } else {
      console.log(chalk.green(`✓ 会话已删除: ${sessionId}`));
      if (ctx.currentSession?.id === sessionId) {
        ctx.currentSession = null;
        ctx.messages.length = 0;
      }
    }
    return true;
  }

  if (trimmed === "/tools") {
    console.log(chalk.bold("\n可用工具:"));
    for (const t of ctx.allTools) {
      const dangerTag = isDangerous(t.name) ? chalk.red(" [需授权]") : "";
      const src = ctx.mcpToolServers.get(t.name);
      const srcTag = src ? chalk.magenta(` (mcp: ${src})`) : "";
      console.log(`  ${chalk.cyan(t.name)}${dangerTag}${srcTag}`);
    }
    for (const name of DEEPAGENT_BUILTIN_TOOL_NAMES) {
      const dangerTag = isDangerous(name) ? chalk.red(" [需授权]") : "";
      console.log(`  ${chalk.cyan(name)}${dangerTag}${chalk.dim(" (deepagents)")}`);
    }
    console.log();
    return true;
  }

  if (trimmed === "/init") {
    console.log(chalk.dim("扫描仓库结构，生成项目上下文..."));
    const projectCtx = generateProjectContext(process.cwd());
    const md = contextToMarkdown(projectCtx);
    const path = writeContextFile(process.cwd(), md);
    ctx.projectContext = md;
    console.log(chalk.green(`✓ 已生成项目上下文: ${path}`));
    console.log(
      chalk.dim(
        `  文件数: ${projectCtx.fileCount} | 语言: ${projectCtx.languageBreakdown.map((l) => `${l.lang}:${l.count}`).join(", ") || "无"}`,
      ),
    );
    console.log(chalk.dim(`  技术栈: ${projectCtx.techStack.join(", ") || "未识别"}`));
    console.log(chalk.dim(`  后续会话将自动加载本文件（可手动编辑补充项目约定）\n`));
    return true;
  }

  if (trimmed === "/context") {
    if (!ctx.projectContext) {
      console.log(
        chalk.dim(`当前未加载项目上下文。在项目根目录运行 /init 生成 ${CONTEXT_FILE_NAME}。\n`),
      );
      return true;
    }
    const preview =
      ctx.projectContext.length > 1600
        ? `${ctx.projectContext.slice(0, 1600)}\n…(已截断)`
        : ctx.projectContext;
    console.log(chalk.bold(`\n当前项目上下文 (${CONTEXT_FILE_NAME}):`));
    console.log(chalk.dim(preview));
    console.log();
    return true;
  }

  if (trimmed === "/mcp") {
    console.log(chalk.bold("\n已配置的 MCP server:"));
    for (const s of listConfiguredServers()) {
      const trusted = trustStore.isTrusted(s.name);
      const status =
        s.trust === "deny"
          ? chalk.red("deny")
          : trusted
            ? chalk.green("trusted")
            : chalk.yellow("untrusted");
      console.log(`  ${chalk.cyan(s.name)} [${status}]`);
    }
    console.log();
    return true;
  }

  if (trimmed === "/mcp trust") {
    const servers = listConfiguredServers().filter((s) => s.trust !== "deny");
    if (servers.length === 0) {
      console.log(chalk.dim("没有可信任的 MCP server（均为 deny）"));
    } else {
      for (const s of servers) trustStore.markAlways(s.name);
      console.log(chalk.green(`✓ 已信任全部 server: ${servers.map((s) => s.name).join(", ")}`));
      void ctx.mcpCleanup().catch(() => {});
      void ctx.rebuildTools().then(() => console.log(chalk.green("✓ 工具已重新加载\n")));
    }
    return true;
  }

  if (trimmed.startsWith("/mcp trust ")) {
    const name = trimmed.slice("/mcp trust ".length).trim();
    const configured = listConfiguredServers().some((s) => s.name === name);
    if (!configured) {
      console.log(chalk.red(`✗ 未配置的 MCP server: ${name}`));
    } else {
      trustStore.markAlways(name);
      console.log(chalk.green(`✓ 已信任并记录: ${name}`));
      void ctx.mcpCleanup().catch(() => {});
      void ctx.rebuildTools().then(() => console.log(chalk.green("✓ 工具已重新加载\n")));
    }
    return true;
  }

  if (trimmed.startsWith("/mcp untrust ")) {
    const name = trimmed.slice("/mcp untrust ".length).trim();
    trustStore.untrust(name);
    console.log(chalk.dim(`已取消信任: ${name}`));
    void ctx.mcpCleanup().catch(() => {});
    void ctx.rebuildTools().then(() => console.log(chalk.green("✓ 工具已重新加载\n")));
    return true;
  }

  if (trimmed === "/help") {
    console.log(chalk.bold("\n可用命令:"));
    console.log(`  ${chalk.cyan("/new")}           - 创建新会话`);
    console.log(`  ${chalk.cyan("/list")}          - 列出所有会话`);
    console.log(`  ${chalk.cyan("/load <id>")}     - 加载指定会话（支持部分 ID）`);
    console.log(`  ${chalk.cyan("/delete <id>")}   - 删除指定会话`);
    console.log(`  ${chalk.cyan("/tools")}         - 列出当前可用工具（含来源 mcp:server）`);
    console.log(`  ${chalk.cyan("/mcp")}           - 查看已配置的 MCP server 信任状态`);
    console.log(`  ${chalk.cyan("/mcp trust <name>")} - 信任某个 MCP server 并重新加载`);
    console.log(`  ${chalk.cyan("/mcp untrust <name>")} - 取消信任某个 MCP server`);
    console.log(`  ${chalk.cyan("/audit")}         - 查看工具调用审计日志`);
    console.log(
      `  ${chalk.cyan("/init")}          - 扫描仓库并生成项目上下文 (${CONTEXT_FILE_NAME})`,
    );
    console.log(`  ${chalk.cyan("/context")}       - 查看当前已加载的项目上下文`);
    console.log(`  ${chalk.cyan("/memory")}        - 查看长期记忆命令`);
    console.log(`  ${chalk.cyan("/help")}          - 显示此帮助`);
    console.log(`  ${chalk.cyan("exit")}           - 退出程序\n`);
    return true;
  }

  if (trimmed === "/audit") {
    const records = listAudit(30);
    if (records.length === 0) {
      console.log(chalk.dim("暂无审计记录"));
    } else {
      console.log(chalk.bold("\n最近的工具调用审计:"));
      for (const r of records) {
        const time = new Date(r.ts).toLocaleTimeString("zh-CN");
        const src =
          r.source === "mcp" ? chalk.magenta(`mcp:${r.server ?? "?"}`) : chalk.cyan("builtin");
        const decision =
          r.decision === "denied"
            ? chalk.red("denied")
            : r.decision === "allowed"
              ? chalk.green("allowed")
              : chalk.dim("auto");
        const summary = r.argsSummary ? chalk.dim(` ${r.argsSummary.slice(0, 60)}`) : "";
        console.log(
          `  ${chalk.dim(time)} ${src} ${chalk.bold(r.toolName)} [${decision}]${summary}`,
        );
      }
      console.log();
    }
    return true;
  }

  return false;
}
