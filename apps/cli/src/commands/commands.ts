import chalk from "chalk";
import type { CliMessage } from "../store/messages.ts";
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
import { formatTokens } from "../ui/terminal.ts";
import { listConfiguredMcpServers, mcpTrustStore, type McpServerTrust } from "../tools/mcpPi.ts";

/** 危险工具判断（Pi 名 + deepagents 名，P1.3 工具名统一过渡期兼容两者）。 */
const DANGEROUS_TOOL_NAMES = new Set([
  "write",
  "edit",
  "bash",
  "write_file",
  "edit_file",
  "execute",
]);

function isDangerousTool(name: string): boolean {
  return DANGEROUS_TOOL_NAMES.has(name);
}

/** MCP 配置/信任存储（P1.4 后统一走 cli 侧 mcpPi）。 */
function mcpServices(ctx: CliContext) {
  return ctx.mcpServices ?? { listServers: listConfiguredMcpServers, store: mcpTrustStore };
}

/** 斜杠命令目录项：用于菜单选择与 /help 展示。 */
export interface SlashCommandDef {
  /** 可执行命令名，如 `/new`、`/mcp trust`。 */
  name: string;
  /** 简短中文说明。 */
  description: string;
  /** 展示用参数提示，如 `<id>`。 */
  argsHint?: string;
  /** 选择后提示用户输入参数的文案；有值表示需要额外参数。 */
  argsPrompt?: string;
  /** 参数可留空（如 /mcp trust 留空表示信任全部）。 */
  argsOptional?: boolean;
}

/**
 * 全部可菜单选择的斜杠命令。
 * 带参数的命令在菜单确认后会再询问参数，再交给 handleCommand 执行。
 */
export const SLASH_COMMANDS: readonly SlashCommandDef[] = [
  { name: "/new", description: "创建新会话" },
  { name: "/list", description: "列出所有会话" },
  {
    name: "/load",
    description: "加载指定会话（支持部分 ID）",
    argsHint: "<id>",
    argsPrompt: "会话 ID",
  },
  { name: "/info", description: "查看当前会话详情（模型/用量）" },
  {
    name: "/delete",
    description: "删除指定会话",
    argsHint: "<id>",
    argsPrompt: "会话 ID",
  },
  { name: "/tools", description: "列出当前可用工具（含来源 mcp:server）" },
  { name: "/mcp", description: "查看已配置的 MCP server 信任状态" },
  {
    name: "/mcp trust",
    description: "信任某个 MCP server 并重新加载",
    argsHint: "[name]",
    argsPrompt: "MCP server 名称（留空=信任全部）",
    argsOptional: true,
  },
  {
    name: "/mcp untrust",
    description: "取消信任某个 MCP server",
    argsHint: "<name>",
    argsPrompt: "MCP server 名称",
  },
  { name: "/audit", description: "查看工具调用审计日志" },
  {
    name: "/init",
    description: `扫描仓库并生成项目上下文 (${CONTEXT_FILE_NAME})`,
  },
  { name: "/context", description: "查看当前已加载的项目上下文" },
  { name: "/memory", description: "查看长期记忆命令" },
  { name: "/help", description: "显示此帮助" },
];

/** 菜单/帮助里展示的命令签名（含参数提示）。 */
export function slashCommandSignature(cmd: SlashCommandDef): string {
  return cmd.argsHint ? `${cmd.name} ${cmd.argsHint}` : cmd.name;
}

/**
 * 按用户输入过滤斜杠命令。
 * query 为 `/` 或空时返回全部；否则按命令名/说明做前缀或包含匹配。
 */
export function filterSlashCommands(query: string): SlashCommandDef[] {
  const raw = query.trim();
  const q = raw.replace(/^\//, "").toLowerCase().trim();
  if (!q) return [...SLASH_COMMANDS];

  return SLASH_COMMANDS.filter((cmd) => {
    const name = cmd.name.slice(1).toLowerCase(); // 去掉前导 /
    const signature = slashCommandSignature(cmd).slice(1).toLowerCase();
    return (
      name.startsWith(q) ||
      signature.startsWith(q) ||
      name.includes(q) ||
      cmd.description.toLowerCase().includes(q)
    );
  });
}

/** 会话 usage 的紧凑展示（无用量时为 ""）。 */
function usageLabel(input: number, output: number, reasoning: number): string {
  if (input <= 0 && output <= 0) return "";
  const reasoningPart = reasoning > 0 ? ` · 推理 ${formatTokens(reasoning)}` : "";
  return ` ${chalk.dim(`⇅ ${formatTokens(input)}/${formatTokens(output)}${reasoningPart} tokens`)}`;
}

/**
 * 跨命令共享的可变状态与依赖。
 * 把原本散落在 index.ts 顶层的模块级变量/函数收敛到这里，
 * 让 handleCommand 以纯参数方式接收，而不是捕获模块作用域闭包，便于测试与复用。
 */
export interface CliContext {
  currentSession: Session | null;
  messages: CliMessage[];
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
  /** 同步历史到 Agent 底座；/load /new 时调用。 */
  setAgentHistory?: (messages: CliMessage[]) => Promise<void>;
  /** 当前可用工具名（/tools 展示用）。 */
  allToolNames?: string[];
  /** MCP 命令依赖；默认使用本地配置和信任存储，测试可注入隔离替身。 */
  mcpServices?: {
    listServers: () => Array<{ name: string; trust: McpServerTrust }>;
    store: Pick<typeof mcpTrustStore, "isTrusted" | "markAlways" | "untrust">;
  };
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
    await ctx.setAgentHistory?.([]);
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
        const usage = usageLabel(
          s.usage?.inputTokens ?? 0,
          s.usage?.outputTokens ?? 0,
          s.usage?.reasoningTokens ?? 0,
        );
        console.log(
          `${prefix} ${chalk.cyan(s.id.slice(0, 8))} ${s.title} ${chalk.dim(`(${date})`)}${usage}`,
        );
      }
      console.log();
    }
    return true;
  }

  if (trimmed === "/info") {
    const session = ctx.currentSession;
    if (!session) {
      console.log(chalk.dim("当前无会话。输入 /new 创建，或 /load <id> 加载已有会话。"));
      return true;
    }
    const count = session.messages.length;
    const reasoningCount = session.messages.filter((m) => m.role === "reasoning").length;
    const toolCount = session.messages.filter((m) => m.role === "tool").length;
    const assistantCount = session.messages.filter((m) => m.role === "assistant").length;
    const userCount = session.messages.filter((m) => m.role === "user").length;
    const usage = session.usage ?? { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
    const totalTokens = usage.inputTokens + usage.outputTokens;

    console.log(chalk.bold("\n会话信息:"));
    console.log(`  会话 ID: ${chalk.cyan(session.id)}`);
    console.log(`  标题: ${session.title}`);
    console.log(`  模型: ${chalk.cyan(process.env.OPENAI_API_MODEL || "Qwen3.6-35B-A3B")}`);
    console.log(`  最近更新: ${new Date(session.updatedAt).toLocaleString("zh-CN")}`);
    console.log();

    console.log(chalk.bold(`  消息统计 (${count}):`));
    console.log(
      `    用户 ${userCount} · 助手 ${assistantCount} · 工具 ${toolCount} · 推理 ${reasoningCount}`,
    );
    console.log();

    console.log(chalk.bold("  累计模型用量:"));
    console.log(
      `    输入 ${chalk.dim(formatTokens(usage.inputTokens))} tokens · ` +
        `输出 ${chalk.dim(formatTokens(usage.outputTokens))} tokens · ` +
        `推理 ${chalk.dim(formatTokens(usage.reasoningTokens))} tokens · ` +
        `总计 ${chalk.dim(formatTokens(totalTokens))} tokens`,
    );
    if (totalTokens > 0) {
      const reasoningPct =
        totalTokens > 0 ? Math.round((usage.reasoningTokens / totalTokens) * 100) : 0;
      console.log(
        `    精确值: ${usage.inputTokens} / ${usage.outputTokens} / ${usage.reasoningTokens} ` +
          chalk.dim(`(推理占比 ${reasoningPct}%)`),
      );
    }
    console.log();

    const lastAssistant = [...session.messages].reverse().find((m) => m.role === "assistant");
    if (lastAssistant) {
      const preview = lastAssistant.content.replace(/\s+/g, " ").slice(0, 60);
      console.log(chalk.bold("  最后回复:"));
      console.log(`    ${chalk.dim(preview)}${lastAssistant.content.length > 60 ? "…" : ""}`);
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
      if (msg.role === "user") ctx.messages.push({ role: "user", content: msg.content });
      else if (msg.role === "assistant")
        ctx.messages.push({ role: "assistant", content: msg.content });
      else if (msg.role === "system") ctx.messages.push({ role: "system", content: msg.content });
      else if (msg.role === "tool") {
        ctx.messages.push({
          role: "tool",
          content: msg.content,
          toolCallId: msg.tool_call_id || "",
          toolName: msg.tool_name,
        });
      }
    }
    console.log(chalk.green(`✓ 已加载会话: ${session.title} (${session.messages.length} 条消息)`));
    await ctx.setAgentHistory?.(ctx.messages);
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
        await ctx.setAgentHistory?.([]);
      }
    }
    return true;
  }

  if (trimmed === "/tools") {
    console.log(chalk.bold("\n可用工具:"));
    for (const name of ctx.allToolNames ?? []) {
      const dangerTag = isDangerousTool(name) ? chalk.red(" [需授权]") : "";
      const src = ctx.mcpToolServers.get(name);
      const srcTag = src ? chalk.magenta(` (mcp: ${src})`) : "";
      console.log(`  ${chalk.cyan(name)}${dangerTag}${srcTag}`);
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
    const { listServers, store } = mcpServices(ctx);
    console.log(chalk.bold("\n已配置的 MCP server:"));
    for (const s of listServers()) {
      const trusted = store.isTrusted(s.name);
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
    const { listServers, store } = mcpServices(ctx);
    const servers = listServers().filter((s) => s.trust !== "deny");
    if (servers.length === 0) {
      console.log(chalk.dim("没有可信任的 MCP server（均为 deny）"));
    } else {
      for (const s of servers) store.markAlways(s.name);
      console.log(chalk.green(`✓ 已信任全部 server: ${servers.map((s) => s.name).join(", ")}`));
      await ctx.rebuildTools();
      console.log(chalk.green("✓ 工具已重新加载\n"));
    }
    return true;
  }

  if (trimmed.startsWith("/mcp trust ")) {
    const { listServers, store } = mcpServices(ctx);
    const name = trimmed.slice("/mcp trust ".length).trim();
    const configured = listServers().some((s) => s.name === name);
    if (!configured) {
      console.log(chalk.red(`✗ 未配置的 MCP server: ${name}`));
    } else {
      store.markAlways(name);
      console.log(chalk.green(`✓ 已信任并记录: ${name}`));
      await ctx.rebuildTools();
      console.log(chalk.green("✓ 工具已重新加载\n"));
    }
    return true;
  }

  if (trimmed.startsWith("/mcp untrust ")) {
    const { store } = mcpServices(ctx);
    const name = trimmed.slice("/mcp untrust ".length).trim();
    store.untrust(name);
    console.log(chalk.dim(`已取消信任: ${name}`));
    await ctx.rebuildTools();
    console.log(chalk.green("✓ 工具已重新加载\n"));
    return true;
  }

  if (trimmed === "/help") {
    console.log(chalk.bold("\n可用命令:"));
    console.log(chalk.dim("  提示: 输入 / 后回车可打开菜单，用 ↑/↓ 选择命令\n"));
    const maxSig = Math.max(...SLASH_COMMANDS.map((c) => slashCommandSignature(c).length), 4);
    for (const cmd of SLASH_COMMANDS) {
      const sig = slashCommandSignature(cmd);
      console.log(`  ${chalk.cyan(sig.padEnd(maxSig))}  - ${cmd.description}`);
    }
    console.log(`  ${chalk.cyan("exit".padEnd(maxSig))}  - 退出程序`);
    console.log();
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
