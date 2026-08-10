/**
 * 查询前置解析链路的公共类型。
 * 设计原则：抽取阶段只产出"原文片段(raw)"，解析阶段才产出"确定值(value)"，
 * 两者严格分离，避免 LLM 越界做日期计算或编码查询。
 */

export type ExpenseEnum = "TRAVEL" | "MEAL" | "ENTERTAIN" | "ALL";
export type ApprovalStatus = "APPROVED" | "REJECTED" | "PENDING" | "ALL";
export type TimeField = "submit" | "approve" | "expense_date";

/** 槽位抽取结果：仅原文片段，未解析 */
export interface DraftSlots {
  date_raw?: string;
  org_raw?: string;
  expense_raw?: string;
  status_raw?: string;
}

export interface DraftQuery {
  intent: "expense_query" | "other";
  slots: DraftSlots;
}

/** 统一的解析器返回契约，编排器据此决定放行 / 反问 / 拒绝 */
export interface ResolverResult<T> {
  value: T | null;
  candidates: { label: string; value: T; score: number }[];
  ambiguous: boolean; // 多个候选且置信度接近
  missing: boolean; // 完全没解析到
  note: string; // 怎么解出来的，写入 caliber 留痕
}

export interface Period {
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
  tz: string;
}

/** 一次查询的完整口径，随结果返回、落日志，保证可复核 */
export interface Caliber {
  intent: string;
  org: { code: string; raw: string; note: string };
  period: Period & { raw: string };
  expense: { enum: ExpenseEnum; raw: string; note: string };
  status: ApprovalStatus;
  time_field: TimeField;
}
