/**
 * P1.1 MCP 工具加载器（Pi defineTool 版）。
 *
 * 自包含实现（不依赖 LangChain / deepagent），复用与 legacy `packages/deepagent/src/tools/mcp.ts`
 * 相同的语义：三级配置 fallback、TrustStore 信任、ACL 过滤、requirePermission 授权、审计 source:"mcp"。
 * 工具包装为 pi-coding-agent 的 defineTool，参数 schema 直接透传 MCP 的 JSON Schema。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AuditEntry } from "../app/piRuntime.ts";

export type McpServerTrust = "trusted" | "confirm" | "deny";

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  trust?: McpServerTrust;
  token?: string;
  allowedTools?: string[];
  deniedTools?: string[];
  requirePermission?: boolean;
}

export interface McpPiLoadResult {
  tools: ToolDefinition[];
  toolServers: Array<{ name: string; server: string }>;
  /** MCP 工具名集合（piRuntime 用于跳过 tool_call 事件的重复审计）。 */
  mcpToolNames: string[];
  cleanup: () => Promise<void>;
  errors: string[];
}

export interface McpPiOptions {
  /** requirePermission=true 的 MCP 工具调用前授权回调。 */
  requestPermission?: (name: string, argsSummary: string) => Promise<boolean>;
  /** 审计回调（source:"mcp"）。 */
  onAudit: (entry: AuditEntry) => void;
}

// ---- 配置加载（三级 fallback） ----

function configPaths(): string[] {
  return [
    process.env.MCP_CONFIG,
    resolve(process.cwd(), "mcp.json"),
    join(homedir(), ".config", "open-agent-tools", "mcp.json"),
  ].filter(Boolean) as string[];
}

function loadConfigs(): McpServerConfig[] {
  for (const p of configPaths()) {
    if (p && existsSync(p)) {
      try {
        const raw = JSON.parse(readFileSync(p, "utf-8")) as { mcpServers?: McpServerConfig[] };
        if (Array.isArray(raw.mcpServers)) return raw.mcpServers;
      } catch {
        // 忽略损坏配置，继续尝试下一个
      }
    }
  }
  return [];
}

/** 列出所有已配置 server（含信任级别），供 /mcp 命令与启动信任确认使用。 */
export function listConfiguredMcpServers(): Array<{ name: string; trust: McpServerTrust }> {
  return loadConfigs().map((c) => ({ name: c.name, trust: c.trust ?? "confirm" }));
}

// ---- 信任存储 ----

const TRUST_PATH = join(homedir(), ".config", "open-agent-tools", "mcp-trust.json");

class McpTrustStore {
  private sessionTrusted = new Set<string>();
  private fileTrusted = new Set<string>();

  constructor() {
    try {
      if (existsSync(TRUST_PATH)) {
        const raw = JSON.parse(readFileSync(TRUST_PATH, "utf-8")) as { trusted?: string[] };
        if (Array.isArray(raw.trusted)) this.fileTrusted = new Set(raw.trusted);
      }
    } catch {
      // 信任文件损坏忽略
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(TRUST_PATH), { recursive: true });
      writeFileSync(TRUST_PATH, JSON.stringify({ trusted: [...this.fileTrusted] }, null, 2));
    } catch {
      // 写入失败不致命
    }
  }

  isTrusted(name: string): boolean {
    return this.fileTrusted.has(name) || this.sessionTrusted.has(name);
  }

  markSession(name: string): void {
    this.sessionTrusted.add(name);
  }

  markAlways(name: string): void {
    this.fileTrusted.add(name);
    this.sessionTrusted.add(name);
    this.persist();
  }

  untrust(name: string): void {
    this.fileTrusted.delete(name);
    this.sessionTrusted.delete(name);
    this.persist();
  }
}

export const mcpTrustStore = new McpTrustStore();

// ---- 工具调用辅助 ----

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .filter((c: { type?: string }) => c.type === "text")
    .map((c: { text?: string }) => c.text ?? "")
    .join("\n");
}

function isAllowedByAcl(cfg: McpServerConfig, toolName: string): boolean {
  const denied = new Set(cfg.deniedTools ?? []);
  if (denied.has(toolName)) return false;
  if (cfg.allowedTools && !cfg.allowedTools.includes(toolName)) return false;
  return true;
}

async function connectOne(
  cfg: McpServerConfig,
  opts: McpPiOptions,
  clients: Client[],
  existingNames: Set<string>,
  toolServers: Array<{ name: string; server: string }>,
  errors: string[],
): Promise<ToolDefinition[]> {
  const client = new Client({ name: "open-agent-tools-pi", version: "0.0.0" });

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

  const out: ToolDefinition[] = [];
  for (const t of tools) {
    if (!isAllowedByAcl(cfg, t.name)) continue;
    if (existingNames.has(t.name)) {
      errors.push(`跳过重复工具名: ${t.name} (来自 MCP ${cfg.name})`);
      continue;
    }
    existingNames.add(t.name);
    toolServers.push({ name: t.name, server: cfg.name });

    const mcpServer = cfg.name;
    out.push(
      defineTool({
        name: t.name,
        label: t.name,
        description: t.description ?? `MCP 工具 ${t.name}`,
        parameters: (t.inputSchema && t.inputSchema.type === "object"
          ? Type.Unsafe<Record<string, unknown>>(t.inputSchema as never)
          : Type.Object({})) as never,
        async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
          const args = (params ?? {}) as Record<string, unknown>;
          const argsSummary = JSON.stringify(args).slice(0, 200);
          const decision = requirePermission ? "allowed" : "auto";
          if (requirePermission) {
            const ok = (await opts.requestPermission?.(t.name, argsSummary)) ?? false;
            if (!ok) {
              opts.onAudit({
                source: "mcp",
                server: mcpServer,
                toolName: t.name,
                decision: "denied",
                argsSummary,
                error: "permission denied",
              });
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({ error: `用户拒绝了 MCP 工具调用: ${t.name}` }),
                  },
                ],
                details: {},
              };
            }
          }

          const audit = (error: string | null): void => {
            opts.onAudit({
              source: "mcp",
              server: mcpServer,
              toolName: t.name,
              decision,
              argsSummary,
              error,
            });
          };

          try {
            const result = await client.callTool({ name: t.name, arguments: args });
            const resultText = extractText(result.content);
            if (result.isError) {
              const error = resultText || "MCP 工具执行失败";
              audit(error);
              return {
                content: [{ type: "text", text: JSON.stringify({ error }) }],
                details: {},
              };
            }
            audit(null);
            return { content: [{ type: "text", text: resultText }], details: {} };
          } catch (error) {
            audit(error instanceof Error ? error.message : String(error));
            throw error;
          }
        },
      }),
    );
  }
  return out;
}

/**
 * 加载所有 MCP server 暴露的工具（Pi defineTool 版）。
 * 与 legacy loadMcpTools 语义一致：trust=deny/未信任跳过（fail-safe）、单点失败隔离、ACL、权限。
 */
export async function loadMcpPiTools(
  existingNames: Set<string>,
  opts: McpPiOptions,
): Promise<McpPiLoadResult> {
  const configs = loadConfigs();
  const tools: ToolDefinition[] = [];
  const toolServers: Array<{ name: string; server: string }> = [];
  const mcpToolNames: string[] = [];
  const errors: string[] = [];
  const clients: Client[] = [];

  for (const cfg of configs) {
    const trust = cfg.trust ?? "confirm";
    if (trust === "deny") {
      errors.push(`MCP server ${cfg.name}: 已显式禁用 (trust=deny)`);
      continue;
    }
    if (trust === "confirm" && !mcpTrustStore.isTrusted(cfg.name)) {
      errors.push(
        `MCP server ${cfg.name}: 未获信任，已跳过（用 /mcp trust ${cfg.name} 信任，或在 mcp.json 设 trust:"trusted"）`,
      );
      continue;
    }

    try {
      const loaded = await connectOne(cfg, opts, clients, existingNames, toolServers, errors);
      tools.push(...loaded);
    } catch (e) {
      errors.push(`MCP server ${cfg.name} 连接失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  mcpToolNames.push(...toolServers.map((t) => t.name));

  return {
    tools,
    toolServers,
    mcpToolNames,
    cleanup: async () => {
      await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
    },
    errors,
  };
}
