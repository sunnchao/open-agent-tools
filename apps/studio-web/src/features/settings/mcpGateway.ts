export interface McpGatewayConfig {
  gatewayUrl: string;
  apiKeyMasked: string | null;
  source: "database" | "environment" | "none";
  configured: boolean;
  updatedAt: string | null;
}

async function readError(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return body.error ?? fallback;
}

export async function fetchMcpGatewayConfig(): Promise<McpGatewayConfig> {
  const response = await fetch("/api/admin/mcp-gateway");
  if (!response.ok) throw new Error(await readError(response, "MCP Gateway 配置加载失败"));
  return ((await response.json()) as { config: McpGatewayConfig }).config;
}

export async function saveMcpGatewayConfig(input: {
  gatewayUrl: string;
  apiKey?: string;
}): Promise<McpGatewayConfig> {
  const response = await fetch("/api/admin/mcp-gateway", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await readError(response, "MCP Gateway 配置保存失败"));
  return ((await response.json()) as { config: McpGatewayConfig }).config;
}

export async function clearMcpGatewayConfig(): Promise<McpGatewayConfig> {
  const response = await fetch("/api/admin/mcp-gateway", { method: "DELETE" });
  if (!response.ok) throw new Error(await readError(response, "MCP Gateway 配置清除失败"));
  return ((await response.json()) as { config: McpGatewayConfig }).config;
}

export function openMcpGatewaySettings(): void {
  sessionStorage.setItem("open-agent-tools.settings-section", "mcp-gateway");
  window.location.hash = "settings";
}
