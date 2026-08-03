import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { executeFinancialReportTool, executeTool, tools } from "./index.js";

describe("function calling — 获取财务报表数据", () => {
  describe("tool schema definition", () => {
    it("exports a non-empty tools array", () => {
      assert.ok(Array.isArray(tools));
      assert.ok(tools.length > 0);
    });

    it("each tool has valid type, function.name, and description", () => {
      for (const tool of tools) {
        assert.equal(tool.type, "function");
        assert.ok(tool.function);
        assert.ok(typeof tool.function.name === "string");
        assert.ok(tool.function.name.length > 0);
        assert.ok(typeof tool.function.description === "string");
        assert.ok(tool.function.description.length > 0);
      }
    });

    it("get_financial_reports has required status parameter", () => {
      const tool = tools.find((t) => t.function.name === "get_financial_reports");
      assert.ok(tool);
      if (tool.function.parameters && typeof tool.function.parameters === "object") {
        const params = tool.function.parameters as Record<string, unknown>;
        assert.ok(params.properties);
        assert.ok(Array.isArray(params.required));
        assert.ok((params.required as string[]).includes("status"));
      }
    });
  });

  describe("executeFinancialReportTool", () => {
    it("returns approved reports when status is 'approved'", async () => {
      const result = await executeFinancialReportTool("approved");
      assert.equal(
        result.content,
        "Here are the financial reports with status approved report1, report2, report3",
      );
      assert.deepEqual(
        result.data.reports.map((report) => report.id),
        ["report1", "report2", "report3"],
      );
    });

    it("returns pending reports when status is 'pending'", async () => {
      const result = await executeFinancialReportTool("pending");
      assert.equal(
        result.content,
        "Here are the financial reports with status pending report4, report5",
      );
      assert.deepEqual(
        result.data.reports.map((report) => report.id),
        ["report4", "report5"],
      );
    });

    it("returns rejected reports when status is 'rejected'", async () => {
      const result = await executeFinancialReportTool("rejected");
      assert.equal(
        result.content,
        "Here are the financial reports with status rejected report6, report7",
      );
      assert.deepEqual(
        result.data.reports.map((report) => report.id),
        ["report6", "report7"],
      );
    });

    it("returns empty list for unknown status", async () => {
      const result = await executeFinancialReportTool("unknown");
      assert.equal(result.content, "Here are the financial reports with status unknown ");
      assert.deepEqual(result.data.reports, []);
    });
  });

  describe("executeTool dispatcher", () => {
    it("dispatches to get_financial_reports with parsed args", async () => {
      const result = await executeTool("get_financial_reports", '{"status":"approved"}');
      assert.equal(result.ui.type, "financial_report_card");
      assert.equal(result.ui.props.reports[0]?.id, "report1");
      assert.equal(result.ui.props.reports[0]?.status, "approved");
    });

    it("rejects unknown tool names", async () => {
      await assert.rejects(executeTool("nonexistent_tool", "{}"), /unknown tool: nonexistent_tool/);
    });

    it("handles empty args string gracefully", async () => {
      const result = await executeTool("get_financial_reports", "");
      assert.equal(result.ui.content, "Here are the financial reports with status unknown ");
      assert.deepEqual(result.ui.props.reports, []);
    });

    it("rejects malformed JSON args", async () => {
      await assert.rejects(executeTool("get_financial_reports", "not-json"), SyntaxError);
    });
  });
});
