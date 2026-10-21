/** 运行期可覆盖；默认与本地三件套对齐。 */
export interface StudioAppConfig {
  agentUrl: string;
  mcpUrl: string;
  mcpGatewayUrl: string;
  apiToken: string;
  workspaceId: string;
}

// Expo only inlines static EXPO_PUBLIC_* references at build time.
const EXPO_AGENT_URL = process.env.EXPO_PUBLIC_AGENT_URL;
const EXPO_MCP_URL = process.env.EXPO_PUBLIC_MCP_URL;
const EXPO_GATEWAY_URL = process.env.EXPO_PUBLIC_MCP_GATEWAY_URL;
const EXPO_TOKEN = process.env.EXPO_PUBLIC_STUDIO_API_TOKEN;

function valueOrDefault(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

export function defaultConfig(): StudioAppConfig {
  return {
    agentUrl: valueOrDefault(EXPO_AGENT_URL, "http://localhost:3000"),
    mcpUrl: valueOrDefault(EXPO_MCP_URL, "http://localhost:4200"),
    mcpGatewayUrl: valueOrDefault(EXPO_GATEWAY_URL, "http://localhost:4100"),
    apiToken: EXPO_TOKEN?.trim() ?? "",
    workspaceId: "",
  };
}

const TOKEN_KEY = "open-agent-tools.studio-api-token";
const WORKSPACE_KEY = "open-agent-tools.workspace-id";
const AGENT_KEY = "open-agent-tools.agent-url";
const MCP_KEY = "open-agent-tools.mcp-url";
const GATEWAY_KEY = "open-agent-tools.mcp-gateway-url";

export { TOKEN_KEY, WORKSPACE_KEY, AGENT_KEY, MCP_KEY, GATEWAY_KEY };

export function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  return `${b}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Control Plane 在 App 侧走 Agent 绝对地址；/mcp-api 前缀统一在此拼接。 */
export function mcpPath(mcpBase: string, path: string): string {
  return joinUrl(mcpBase, `/api/admin/mcp${path.startsWith("/") ? path : `/${path}`}`);
}
