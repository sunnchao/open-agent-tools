import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";

/** MCP 工具调用审计记录（与 AgentCallbacks.onAudit 结构一致，source 固定为 "mcp"）。 */
export interface McpAuditEntry {
  source: "mcp";
  server: string;
  toolName: string;
  decision: "allowed" | "denied" | "auto";
  argsSummary: string;
}

// ---- MCP server 配置 ----

export type McpServerTrust = "trusted" | "confirm" | "deny";

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "http";
  /** stdio 传输 */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http 传输（Streamable HTTP） */
  url?: string;
  /**
   * 信任级别（安全底线）：
   * - trusted：直接加载，不再询问
   * - confirm（默认）：需用户显式信任，否则跳过（fail-safe）
   * - deny：永不加载
   */
  trust?: McpServerTrust;
  /** HTTP 传输的 Bearer Token（也可走 MCP_TOKEN 环境变量）。 */
  token?: string;
  /** 仅暴露这些工具；省略表示暴露全部（仍受 deniedTools 约束）。 */
  allowedTools?: string[];
  /** 显式禁用的工具（优先于 allowedTools，命中即不暴露给 agent）。 */
  deniedTools?: string[];
  /** 调用本 server 的工具前是否请求用户授权（默认 false）。 */
  requirePermission?: boolean;
}

export interface McpLoadResult {
  tools: StructuredToolInterface[];
  toolServers: Array<{ name: string; server: string }>;
  cleanup: () => Promise<void>;
  errors: string[];
}

export interface McpLoadOptions {
  /** 危险 MCP 工具调用前的授权回调；返回 true 放行 / false 拒绝。 */
  permission?: (name: string, argsSummary: string) => Promise<boolean>;
  /** 审计回调（记录 MCP 工具调用决策）。 */
  audit?: (entry: McpAuditEntry) => void;
}

// ---- 配置加载（三级 fallback：MCP_CONFIG 环境变量 → 项目根 mcp.json → 用户 home） ----

const CONFIG_PATHS = [
  process.env.MCP_CONFIG,
  resolve(process.cwd(), "mcp.json"),
  join(homedir(), ".config", "open-agent-tools", "mcp.json"),
].filter(Boolean) as string[];

function loadConfigs(): McpServerConfig[] {
  for (const p of CONFIG_PATHS) {
    if (p && existsSync(p)) {
      try {
        const raw = JSON.parse(readFileSync(p, "utf-8")) as { mcpServers?: McpServerConfig[] };
        if (Array.isArray(raw.mcpServers)) return raw.mcpServers;
      } catch {
        // 忽略损坏的配置文件，继续尝试下一个
      }
    }
  }
  return [];
}

/** 列出所有已配置的 server（含其信任级别），供 /mcp 命令与启动信任确认使用。 */
export function listConfiguredServers(): Array<{ name: string; trust: McpServerTrust }> {
  return loadConfigs().map((c) => ({ name: c.name, trust: c.trust ?? "confirm" }));
}

// ---- 信任存储（持久化到 ~/.config/open-agent-tools/mcp-trust.json，避免每次启动重复询问） ----

const TRUST_PATH = join(homedir(), ".config", "open-agent-tools", "mcp-trust.json");

class TrustStore {
  private sessionTrusted = new Set<string>();
  private fileTrusted = new Set<string>();

  constructor() {
    try {
      if (existsSync(TRUST_PATH)) {
        const raw = JSON.parse(readFileSync(TRUST_PATH, "utf-8")) as { trusted?: string[] };
        if (Array.isArray(raw.trusted)) this.fileTrusted = new Set(raw.trusted);
      }
    } catch {
      // 信任文件损坏则忽略，当作未信任
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(TRUST_PATH), { recursive: true });
      writeFileSync(TRUST_PATH, JSON.stringify({ trusted: [...this.fileTrusted] }, null, 2));
    } catch {
      // 写入失败不致命（下次仍会询问）
    }
  }

  isTrusted(name: string): boolean {
    return this.fileTrusted.has(name) || this.sessionTrusted.has(name);
  }

  /** 仅本次会话信任。 */
  markSession(name: string): void {
    this.sessionTrusted.add(name);
  }

  /** 永久信任（写入文件）。 */
  markAlways(name: string): void {
    this.fileTrusted.add(name);
    this.sessionTrusted.add(name);
    this.persist();
  }

  /** 取消信任（从文件与会话中移除）。 */
  untrust(name: string): void {
    this.fileTrusted.delete(name);
    this.sessionTrusted.delete(name);
    this.persist();
  }
}

export const trustStore = new TrustStore();

// ---- 工具调用辅助 ----

export function extractText(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .filter((c: { type?: string }) => c.type === "text")
    .map((c: { text?: string }) => c.text ?? "")
    .join("\n");
}

export function isAllowedByAcl(cfg: McpServerConfig, toolName: string): boolean {
  const denied = new Set(cfg.deniedTools ?? []);
  if (denied.has(toolName)) return false;
  if (cfg.allowedTools && !cfg.allowedTools.includes(toolName)) return false;
  return true;
}

async function connectOne(
  cfg: McpServerConfig,
  opts: McpLoadOptions,
  clients: Client[],
): Promise<StructuredToolInterface[]> {
  const client = new Client({ name: "open-agent-tools-deepagent", version: "0.0.0" });

  if (cfg.transport === "http") {
    if (!cfg.url) throw new Error(`MCP server ${cfg.name}: http 传输缺少 url`);
    const token = cfg.token ?? process.env.MCP_TOKEN;
    const requestInit = token ? { headers: { Authorization: `Bearer ${token}` } } : undefined;
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(cfg.url),
        requestInit ? { requestInit } : undefined,
      ),
    );
  } else {
    if (!cfg.command) throw new Error(`MCP server ${cfg.name}: stdio 传输缺少 command`);
    await client.connect(
      new StdioClientTransport({
        command: cfg.command,
        args: cfg.args ?? [],
        env: { ...process.env, ...(cfg.env ?? {}) } as Record<string, string>,
      }),
    );
  }
  clients.push(client);

  const { tools } = await client.listTools();
  const requirePermission = cfg.requirePermission ?? false;

  return tools
    .filter((t) => isAllowedByAcl(cfg, t.name))
    .map((t) =>
      tool(
        async (args: Record<string, unknown>) => {
          const argsSummary = JSON.stringify(args).slice(0, 200);
          if (requirePermission && opts.permission) {
            const ok = await opts.permission(t.name, argsSummary);
            if (!ok) {
              opts.audit?.({
                source: "mcp",
                server: cfg.name,
                toolName: t.name,
                decision: "denied",
                argsSummary,
              });
              return JSON.stringify({ error: `用户拒绝了 MCP 工具调用: ${t.name}` });
            }
            opts.audit?.({
              source: "mcp",
              server: cfg.name,
              toolName: t.name,
              decision: "allowed",
              argsSummary,
            });
          } else {
            opts.audit?.({
              source: "mcp",
              server: cfg.name,
              toolName: t.name,
              decision: "auto",
              argsSummary,
            });
          }

          const result = await client.callTool({ name: t.name, arguments: args });
          if (result.isError) {
            return JSON.stringify({
              error: extractText((result as { content?: unknown }).content),
            });
          }
          return extractText((result as { content?: unknown }).content);
        },
        {
          name: t.name,
          description: t.description ?? `MCP 工具 ${t.name}`,
          schema: z.record(z.string(), z.unknown()),
          // 用 metadata 标记该工具来自哪个 MCP server，供 agent 端区分来源、避免双重鉴权。
          metadata: { mcpServer: cfg.name },
        },
      ),
    );
}

/**
 * 从 mcp.json（或 MCP_CONFIG 指定的路径）加载所有 MCP server 暴露的工具。
 * 安全策略：
 *  - trust=deny 或不在 trustStore 中的 server 直接跳过（fail-safe，不会静默加载）。
 *  - 任一 server 连接失败不影响其它 server；失败信息收集到 errors。
 *  - 工具名重复检测、ACL 过滤（allowedTools/deniedTools）、requirePermission 授权均在此时施加。
 * 若没有任何配置，返回空工具列表（非致命）。
 */
export async function loadMcpTools(
  existingNames: Set<string>,
  opts: McpLoadOptions = {},
): Promise<McpLoadResult> {
  const configs = loadConfigs();
  const tools: StructuredToolInterface[] = [];
  const toolServers: Array<{ name: string; server: string }> = [];
  const errors: string[] = [];
  const clients: Client[] = [];

  for (const cfg of configs) {
    const trust = cfg.trust ?? "confirm";
    if (trust === "deny") {
      errors.push(`MCP server ${cfg.name}: 已显式禁用 (trust=deny)`);
      continue;
    }
    // trust=trusted 已在配置中显式信任，直接加载；其余（confirm/默认）需经信任存储确认。
    if (trust === "confirm" && !trustStore.isTrusted(cfg.name)) {
      errors.push(
        `MCP server ${cfg.name}: 未获信任，已跳过（用 /mcp trust ${cfg.name} 信任，或在 mcp.json 设 trust:"trusted"）`,
      );
      continue;
    }

    try {
      const loaded = await connectOne(cfg, opts, clients);
      for (const lt of loaded) {
        if (existingNames.has(lt.name)) {
          errors.push(`跳过重复工具名: ${lt.name} (来自 MCP ${cfg.name})`);
          continue;
        }
        existingNames.add(lt.name);
        tools.push(lt);
        toolServers.push({ name: lt.name, server: cfg.name });
      }
    } catch (e) {
      errors.push(`MCP server ${cfg.name} 连接失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    tools,
    toolServers,
    errors,
    cleanup: async () => {
      await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
    },
  };
}
