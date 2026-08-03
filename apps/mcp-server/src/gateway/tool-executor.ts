import type { ToolExecutionJob } from "@open-agent-tools/mcp-contracts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type ToolExecutionRequest = ToolExecutionJob;

export interface ToolExecutor {
  execute(request: ToolExecutionRequest): Promise<CallToolResult>;
}
