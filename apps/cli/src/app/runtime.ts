import readline from "node:readline";
import { createAgentCallbacks, type StreamableAgentCallbacks } from "../ui/agentCallbacks.ts";
import { createAsk, createConfirm } from "../ui/cliUi.ts";
import type { CliContext } from "../commands/commands.ts";
import type { CliMessage } from "../store/messages.ts";
import { MemoryStore } from "../store/memory.ts";
import { PermissionManager } from "../tools/permissions.ts";
import { logAudit } from "../store/db.ts";
import { createPiRuntime, type PiRuntime } from "./piRuntime.ts";

export interface Runtime {
  rl: readline.Interface;
  cli: CliContext;
  /** PI Agent 底座（唯一执行内核）。 */
  pi: PiRuntime;
  callbacks: StreamableAgentCallbacks;
  permissionManager: PermissionManager;
  memoryStore: MemoryStore;
  rebuildTools: () => Promise<void>;
}

/** 创建 readline、权限、CliContext 与可重建的 Pi 工具/会话装配。 */
export async function createRuntime(): Promise<Runtime> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const memoryStore = new MemoryStore({ cwd: process.cwd() });
  const ask = createAsk(rl);
  const permissionManager = new PermissionManager(createConfirm(rl));

  const cli: CliContext = {
    currentSession: null,
    messages: [],
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
    error?: string | null;
  }): void => {
    logAudit({ ...entry, sessionId: cli.currentSession?.id ?? null });
  };

  const callbacks = createAgentCallbacks({
    cli,
    permissionManager,
  });

  const runtime: Runtime = {
    rl,
    cli,
    pi: null as unknown as PiRuntime,
    callbacks,
    permissionManager,
    memoryStore,
    rebuildTools: async () => {
      await runtime.pi.rebuild();
      cli.allToolNames = runtime.pi.getToolNames();
      cli.mcpToolServers = new Map(runtime.pi.getMcpToolServers().map((t) => [t.name, t.server]));
    },
  };

  runtime.pi = await createPiRuntime({
    cwd: process.cwd(),
    onAudit: recordAudit,
    memoryStore,
    currentSessionId: () => cli.currentSession?.id,
    requestPermission: (name, args) => permissionManager.decide(name, args),
  });
  // 退出时清理 Pi 底座（含 MCP 连接）。
  cli.mcpCleanup = async () => {
    runtime.pi.dispose();
  };
  // /load /new 时把历史同步给 Pi 底座（仅 user/assistant 纯文本轮次）。
  cli.setAgentHistory = (messages: CliMessage[]) => {
    return runtime.pi.setHistory(
      messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    );
  };

  cli.rebuildTools = () => runtime.rebuildTools();

  return runtime;
}
