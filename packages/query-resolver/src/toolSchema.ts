import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { Caliber } from "./types.js";

/** 强约束的查询参数 schema：组织/费用/状态都是 enum，模型只能从候选里选 */
export const queryExpenseApprovalSchema = z.object({
  org_code: z.enum(["BJ-BRANCH", "SH-BRANCH", "GZ-BRANCH"]),
  period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  expense_type: z.enum(["TRAVEL", "MEAL", "ENTERTAIN"]).default("TRAVEL"),
  status: z.enum(["APPROVED", "REJECTED", "PENDING", "ALL"]).default("APPROVED"),
  time_field: z.enum(["submit", "approve", "expense_date"]).default("approve"),
  page: z.number().int().min(1).default(1),
  page_size: z.number().int().min(1).max(200).default(50),
});

export type QueryExpenseApprovalArgs = z.infer<typeof queryExpenseApprovalSchema>;

/** 真实数据源接入点：把链路算出的参数打到费控/ERP/OA */
export interface ExpenseDataSource {
  query(args: QueryExpenseApprovalArgs): Promise<{
    total: number;
    rows: unknown[];
    caliber: unknown;
  }>;
}

export function createExpenseApprovalTool(dataSource: ExpenseDataSource) {
  return tool(
    async (args) => {
      const res = await dataSource.query(args);
      return JSON.stringify(res);
    },
    {
      name: "query_expense_approval",
      description:
        "查询指定组织、时间段内、某费用类型与审批状态的报销审批单据。用于差旅/招待等费用审计与统计。时间按北京时间自然月，组织用快照编码。",
      schema: queryExpenseApprovalSchema,
    },
  );
}

/** JSON Schema 版本，供非 LangChain 的 function calling 使用 */
export const queryExpenseApprovalJsonSchema = {
  name: "query_expense_approval",
  description: "查询指定组织、时间段内、某费用类型与审批状态的报销审批单据。",
  parameters: {
    type: "object",
    required: ["org_code", "period_start", "period_end"],
    properties: {
      org_code: { type: "string", enum: ["BJ-BRANCH", "SH-BRANCH", "GZ-BRANCH"], description: "组织快照编码" },
      period_start: { type: "string", description: "开始日期 YYYY-MM-DD" },
      period_end: { type: "string", description: "结束日期 YYYY-MM-DD" },
      expense_type: { type: "string", enum: ["TRAVEL", "MEAL", "ENTERTAIN"], default: "TRAVEL" },
      status: { type: "string", enum: ["APPROVED", "REJECTED", "PENDING", "ALL"], default: "APPROVED" },
      time_field: { type: "string", enum: ["submit", "approve", "expense_date"], default: "approve" },
      page: { type: "integer", default: 1 },
      page_size: { type: "integer", default: 50 },
    },
  },
} as const;

/** 槽位抽取用的"强制工具调用"schema：模型只填已知维度的原文片段 */
export const extractSlotsToolSchema = {
  name: "extract_slots",
  description: "从用户话术中抽取查询维度原文片段。只引用原话，不要推断或计算具体日期/编码。",
  parameters: {
    type: "object",
    properties: {
      date_raw: { type: "string", description: "时间相关原文，如'上个月'" },
      org_raw: { type: "string", description: "组织相关原文，如'北京分公司'" },
      expense_raw: { type: "string", description: "费用类型原文，如'差旅报销'" },
      status_raw: { type: "string", description: "审批状态原文，如'已通过'，无则省略" },
    },
  },
} as const;

/** caliber → function tool 入参 */
export function caliberToArgs(caliber: Caliber): QueryExpenseApprovalArgs {
  // 生产环境应在 resolve 阶段校验 org.code ∈ 允许枚举；此处按边界收窄
  return {
    org_code: caliber.org.code as QueryExpenseApprovalArgs["org_code"],
    period_start: caliber.period.start,
    period_end: caliber.period.end,
    expense_type: caliber.expense.enum === "ALL" ? "TRAVEL" : caliber.expense.enum,
    status: caliber.status,
    time_field: caliber.time_field,
    page: 1,
    page_size: 50,
  };
}
