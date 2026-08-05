import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface GatewayToolCall {
  serviceSlug: string;
  apiKey: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export async function callGatewayTool(
  input: GatewayToolCall,
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new Error("请输入 Gateway API Key");

  const endpoint = new URL(
    `/mcp/services/${encodeURIComponent(input.serviceSlug)}`,
    window.location.origin,
  );
  const client = new Client({ name: "open-agent-studio", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: {
      headers: { authorization: `Bearer ${apiKey}` },
    },
  });

  try {
    await client.connect(transport);
    return await client.callTool({ name: input.toolName, arguments: input.arguments });
  } finally {
    await client.close().catch(() => undefined);
  }
}
