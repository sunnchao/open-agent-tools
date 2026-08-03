import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// 示例数据，与 apps/server 中 get_financial_reports 同源。
// 真实项目中应由数据源或共享包（packages/shared）提供。
export const REPORTS: Record<string, Array<{ id: string; name: string; status: string }>> = {
  approved: [
    { id: "report1", name: "Report 1", status: "approved" },
    { id: "report2", name: "Report 2", status: "approved" },
    { id: "report3", name: "Report 3", status: "approved" },
  ],
  pending: [
    { id: "report4", name: "Report 4", status: "pending" },
    { id: "report5", name: "Report 5", status: "pending" },
  ],
  rejected: [
    { id: "report6", name: "Report 6", status: "rejected" },
    { id: "report7", name: "Report 7", status: "rejected" },
  ],
};

/**
 * 向 MCP 服务器注册工具。
 * 每个工具返回一个 content 列表，文本结果用 type: "text" 承载。
 */
export function registerTools(server: McpServer): void {
  server.tool(
    "get_financial_reports",
    "获取财务报表数据，按审批状态过滤（approved / pending / rejected）。",
    { status: z.string().describe("审批状态：approved / pending / rejected") },
    async ({ status }) => {
      const reports = REPORTS[status] ?? [];
      return {
        content: [{ type: "text", text: JSON.stringify({ status, reports }, null, 2) }],
      };
    },
  );

  server.tool("get_server_time", "返回 MCP 服务的当前时间，ISO 8601 格式。", {}, async () => {
    return {
      content: [{ type: "text", text: new Date().toISOString() }],
    };
  });

  server.tool("add", "对两个整数求和。", { a: z.number(), b: z.number() }, async ({ a, b }) => {
    return {
      content: [{ type: "text", text: String(a + b) }],
    };
  });
}
