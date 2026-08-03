// 预置函数定义

import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions/completions";

export const tools: ChatCompletionFunctionTool[] = [
  {
    type: "function",
    function: {
      name: "get_financial_reports",
      description: "获取财务报表数据",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            description: "The status of the financial report e.g. approved, pending, rejected",
          },
        },
        required: ["status"],
      },
    },
  },
];

interface FinancialReport {
  id: string;
  name: string;
  status: string;
}

interface FinancialReportToolResult {
  content: string;
  data: {
    reports: FinancialReport[];
  };
}

interface ToolExecutionResult {
  ok: true;
  ui: {
    type: "financial_report_card";
    content: string;
    props: FinancialReportToolResult["data"];
  };
}

const reportsByStatus = new Map<string, FinancialReport[]>([
  [
    "approved",
    [
      { id: "report1", name: "Report 1", status: "approved" },
      { id: "report2", name: "Report 2", status: "approved" },
      { id: "report3", name: "Report 3", status: "approved" },
    ],
  ],
  [
    "pending",
    [
      { id: "report4", name: "Report 4", status: "pending" },
      { id: "report5", name: "Report 5", status: "pending" },
    ],
  ],
  [
    "rejected",
    [
      { id: "report6", name: "Report 6", status: "rejected" },
      { id: "report7", name: "Report 7", status: "rejected" },
    ],
  ],
]);

export async function executeTool(name: string, argsJson: string): Promise<ToolExecutionResult> {
  const args = (argsJson ? JSON.parse(argsJson) : {}) as { status?: unknown };
  switch (name) {
    // 调用 get_financial_reports 工具获取报表数据
    case "get_financial_reports": {
      const status = typeof args.status === "string" ? args.status : "unknown";
      const toolResults = await executeFinancialReportTool(status);
      return {
        ok: true,
        ui: {
          type: "financial_report_card",
          content: toolResults.content,
          props: toolResults.data,
        },
      };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

export async function executeFinancialReportTool(
  status: string,
): Promise<FinancialReportToolResult> {
  const reports = reportsByStatus.get(status) ?? [];
  const reportIds = reports.map((report) => report.id).join(", ");
  return {
    content: `Here are the financial reports with status ${status} ${reportIds}`,
    data: { reports },
  };
}
