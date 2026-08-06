import type { McpScope, McpService, McpVersion } from "./api.js";

export interface GrantCapabilities {
  versionNumber: number | null;
  toolCount: number;
  promptCount: number;
}

const scopeOrder: McpScope[] = [
  "mcp:connect",
  "tools:list",
  "tools:call",
  "prompts:list",
  "prompts:get",
];

export function grantCapabilities(service: McpService, versions: McpVersion[]): GrantCapabilities {
  const current = versions.find(
    (version) => version.id === service.currentVersionId && version.status === "PUBLISHED",
  );
  return {
    versionNumber: current?.versionNumber ?? null,
    toolCount: current?.tools.length ?? 0,
    promptCount: current?.prompts.length ?? 0,
  };
}

export function supportsGrantScope(scope: McpScope, capabilities: GrantCapabilities): boolean {
  if (scope === "mcp:connect") return true;
  if (scope.startsWith("tools:")) return capabilities.toolCount > 0;
  return capabilities.promptCount > 0;
}

export function constrainGrantScopes(
  selected: Iterable<McpScope>,
  capabilities: GrantCapabilities,
): McpScope[] {
  const values = new Set(selected);
  values.add("mcp:connect");
  return scopeOrder.filter((scope) => values.has(scope) && supportsGrantScope(scope, capabilities));
}
