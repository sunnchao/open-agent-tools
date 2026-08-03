import readline from "node:readline";
import { ChatOpenAI } from "@langchain/openai";
import {
  Agent,
  DEEPAGENT_BUILTIN_TOOL_NAMES,
  LocalShellBackend,
  getBuiltinTools,
  loadMcpTools,
  type AgentOptions,
} from "@open-agent-tools/deepagent";
import chalk from "chalk";
import { createAgentCallbacks, type StreamableAgentCallbacks } from "../ui/agentCallbacks.ts";
import { createAsk, createConfirm } from "../ui/cliUi.ts";
import type { CliContext } from "../commands/commands.ts";
import { MemoryStore } from "../store/memory.ts";
import { createMemoryTools } from "../tools/memory.ts";
import { PermissionManager } from "../tools/permissions.ts";
import { logAudit } from "../store/db.ts";

const INTERRUPT_ON: NonNullable<AgentOptions["interruptOn"]> = {
  write_file: { allowedDecisions: ["approve", "reject"] },
  edit_file: { allowedDecisions: ["approve", "reject"] },
  execute: { allowedDecisions: ["approve", "reject"] },
};

export interface Runtime {
  rl: readline.Interface;
  cli: CliContext;
  /** 首次 rebuildTools 之后才可用。 */
  agent: Agent;
  callbacks: StreamableAgentCallbacks;
  permissionManager: PermissionManager;
  memoryStore: MemoryStore;
  baseModel: ChatOpenAI;
  rebuildTools: () => Promise<void>;
}

/** 创建 readline、模型、权限、CliContext 与可重建的工具/Agent 装配。 */
export async function createRuntime(): Promise<Runtime> {
  const backend = await LocalShellBackend.create({
    rootDir: process.cwd(),
    virtualMode: false,
    inheritEnv: true,
    timeout: 30,
  });
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const baseModel = new ChatOpenAI({
    modelName: process.env.OPENAI_API_MODEL || "Qwen3.6-35B-A3B",
    configuration: {
      baseURL: process.env.OPENAI_API_BASE_URL,
      apiKey: process.env.OPENAI_API_KEY,
    },
  });

  const memoryStore = new MemoryStore({ cwd: process.cwd() });
  const ask = createAsk(rl);
  const permissionManager = new PermissionManager(createConfirm(rl));

  const cli: CliContext = {
    currentSession: null,
    messages: [],
    allTools: [],
    projectContext: null,
    mcpToolServers: new Map<string, string>(),
    rebuildTools: async () => {},
    mcpCleanup: async () => {},
    memoryStore,
    ask,
  };

  const recordAudit = (entry: {
    source: "builtin" | "mcp";
    server?: string | null;
    toolName: string;
    decision: "allowed" | "denied" | "auto";
    argsSummary?: string;
  }): void => {
    logAudit({ ...entry, sessionId: cli.currentSession?.id ?? null });
  };

  const callbacks = createAgentCallbacks({ cli, permissionManager });

  const runtime: Runtime = {
    rl,
    cli,
    agent: null as unknown as Agent,
    callbacks,
    permissionManager,
    memoryStore,
    baseModel,
    rebuildTools: async () => {
      const builtins = getBuiltinTools();
      const memoryTools = createMemoryTools({
        store: memoryStore,
        currentSessionId: () => cli.currentSession?.id,
        modelName: process.env.OPENAI_API_MODEL || "Qwen3.6-35B-A3B",
      });
      const customTools = [...builtins, ...memoryTools];
      const names = new Set(DEEPAGENT_BUILTIN_TOOL_NAMES);
      for (const tool of customTools) names.add(tool.name);
      const mcp = await loadMcpTools(names, {
        permission: (name, args) => permissionManager.decide(name, args),
        audit: recordAudit,
      });
      for (const e of mcp.errors) console.log(chalk.yellow(`MCP: ${e}`));
      if (mcp.tools.length > 0) {
        console.log(chalk.dim(`已加载 ${mcp.tools.length} 个 MCP 工具`));
      }
      cli.allTools = [...customTools, ...mcp.tools];
      cli.mcpToolServers = new Map(mcp.toolServers.map((t) => [t.name, t.server]));
      cli.mcpCleanup = mcp.cleanup;
      runtime.agent = new Agent(baseModel, cli.allTools, {
        backend,
        interruptOn: INTERRUPT_ON,
      });
    },
  };

  cli.rebuildTools = () => runtime.rebuildTools();

  return runtime;
}
