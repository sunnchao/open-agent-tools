/**
 * DTMS（湖北国贸供应链协同管理平台）问数一期业务目录。
 *
 * 严格限定业务类型：合同 / 发票 / 付款 / 收款 / 库存 / 清算。
 * 禁止注入 NEW-API 运营库（logs/users/tokens/quota 等）或其它无关系统。
 *
 * 表名为一期只读视图/表白名单。REPORT_DATABASE_URL 必须指向 DTMS 只读库，
 * 未出现在本目录的表一律拒绝执行。
 */

export const DTMS_INDUSTRIES = ["煤炭", "钢材", "车辆", "纸浆", "农产品", "有色", "其它"] as const;
export type DtmsIndustry = (typeof DTMS_INDUSTRIES)[number];

export const DTMS_MODULES = ["合同", "发票", "付款", "收款", "库存", "清算"] as const;
export type DtmsModule = (typeof DTMS_MODULES)[number];

export interface DtmsColumn {
  name: string;
  title: string;
  type: "string" | "number" | "date" | "enum";
  sensitive?: boolean;
}

export interface DtmsTable {
  name: string;
  title: string;
  module: DtmsModule;
  description: string;
  columns: DtmsColumn[];
}

const INDUSTRY_COL: DtmsColumn = {
  name: "industry",
  title: "行业",
  type: "enum",
};

const ORG_COL: DtmsColumn = {
  name: "org_no",
  title: "组织编号",
  type: "string",
};

/** 中台子系统 id → DTMS 行业（与 dtms-web SysTypeEnum 对齐）。 */
export const SYS_ID_TO_INDUSTRY: Record<number, DtmsIndustry> = {
  13001: "煤炭",
  14001: "钢材",
  15001: "车辆",
  18001: "纸浆",
  19001: "农产品",
  24001: "有色",
  25001: "其它",
};

const MODULE_MENU_PATTERNS: Array<{ module: DtmsModule; test: RegExp }> = [
  { module: "发票", test: /invoice|invoicing|开票|认票|进项票|销项票/ },
  { module: "付款", test: /payment|付款/ },
  { module: "收款", test: /collection|receivale|收款|回款/ },
  { module: "库存", test: /cargo|inventory|in-stock|out-stock|receiving|stock|库存|出入库|收货/ },
  { module: "清算", test: /statement|liquidation|settle|清算|结算/ },
  { module: "合同", test: /contract|合同/ },
];

export const DTMS_TABLES: DtmsTable[] = [
  {
    name: "dtms_contract",
    title: "合同",
    module: "合同",
    description: "采购/销售合同主数据。金额单位元，数量按合同量。",
    columns: [
      { name: "contract_outer_no", title: "合同编号", type: "string" },
      { name: "contract_type", title: "合同类型（采购/销售）", type: "enum" },
      INDUSTRY_COL,
      ORG_COL,
      { name: "from_customer_name", title: "供应商/卖方", type: "string" },
      { name: "to_customer_name", title: "客户/买方", type: "string" },
      { name: "total_amount", title: "合同金额（元）", type: "number" },
      { name: "contract_ton", title: "合同量", type: "number" },
      { name: "sign_date", title: "签订日期", type: "date" },
      { name: "contract_status", title: "合同状态", type: "string" },
    ],
  },
  {
    name: "dtms_invoice",
    title: "发票",
    module: "发票",
    description: "进项/销项发票与认票金额。金额单位元。",
    columns: [
      { name: "invoice_no", title: "发票号码", type: "string" },
      { name: "contract_outer_no", title: "合同编号", type: "string" },
      INDUSTRY_COL,
      ORG_COL,
      { name: "payee_name", title: "开票方", type: "string" },
      { name: "payer_name", title: "收票方", type: "string" },
      { name: "invoice_amount", title: "开票/认票金额（元）", type: "number" },
      { name: "invoice_tons", title: "开票/认票吨数", type: "number" },
      { name: "invoice_date", title: "开票日期", type: "date" },
    ],
  },
  {
    name: "dtms_payment",
    title: "付款",
    module: "付款",
    description: "付款申请与付款单。金额单位元。",
    columns: [
      { name: "pay_no", title: "付款编号", type: "string" },
      { name: "contract_outer_no", title: "合同编号", type: "string" },
      INDUSTRY_COL,
      ORG_COL,
      { name: "payee_name", title: "收款方", type: "string" },
      { name: "pay_amount", title: "付款金额（元）", type: "number" },
      { name: "pay_date", title: "付款日期", type: "date" },
      { name: "pay_status", title: "付款状态", type: "string" },
    ],
  },
  {
    name: "dtms_receipt",
    title: "收款",
    module: "收款",
    description: "收款登记。金额单位元。",
    columns: [
      { name: "receipt_no", title: "收款编号", type: "string" },
      { name: "contract_outer_no", title: "合同编号", type: "string" },
      INDUSTRY_COL,
      ORG_COL,
      { name: "payer_name", title: "付款方", type: "string" },
      { name: "receipt_amount", title: "收款金额（元）", type: "number" },
      { name: "receipt_date", title: "收款日期", type: "date" },
    ],
  },
  {
    name: "dtms_inventory",
    title: "库存",
    module: "库存",
    description: "库存结存。数量按吨/件，金额单位元。",
    columns: [
      { name: "stock_no", title: "库存单号", type: "string" },
      INDUSTRY_COL,
      ORG_COL,
      { name: "goods_name", title: "货物名称", type: "string" },
      { name: "warehouse_name", title: "仓库", type: "string" },
      { name: "stock_qty", title: "库存数量", type: "number" },
      { name: "stock_amount", title: "库存金额（元）", type: "number" },
      { name: "stock_date", title: "库存日期", type: "date" },
    ],
  },
  {
    name: "dtms_settlement",
    title: "清算",
    module: "清算",
    description: "清算/结算单。金额单位元。",
    columns: [
      { name: "settle_no", title: "清算单编号", type: "string" },
      { name: "contract_outer_no", title: "合同编号", type: "string" },
      INDUSTRY_COL,
      ORG_COL,
      { name: "settle_amount", title: "清算金额（元）", type: "number" },
      { name: "settle_tons", title: "清算吨数", type: "number" },
      { name: "settle_date", title: "清算日期", type: "date" },
    ],
  },
];

export const DTMS_TABLE_NAMES: readonly string[] = DTMS_TABLES.map((t) => t.name);

/** NEW-API / 其它系统标识，出现在 SQL 中一律拦截。 */
export const BLOCKED_FOREIGN_TABLES = [
  "logs",
  "users",
  "tokens",
  "channels",
  "orders",
  "top_ups",
  "payments",
  "quota_data",
  "statistics",
  "redemptions",
  "models",
  "prices",
  "abilities",
  "information_schema",
  "mysql",
  "performance_schema",
  "sys",
] as const;

const PAGE_CONTEXT_MODULE: Array<{ test: RegExp; module: DtmsModule }> = [
  { test: /invoice|invoicing|开票|认票/, module: "发票" },
  { test: /payment|付款/, module: "付款" },
  { test: /collection|receivale|收款/, module: "收款" },
  { test: /cargo|inventory|in-stock|out-stock|receiving|库存|出入库/, module: "库存" },
  { test: /statement|liquidation|settle|清算|结算/, module: "清算" },
  { test: /contract|合同/, module: "合同" },
];

const PAGE_CONTEXT_INDUSTRY: Array<{ test: RegExp; industry: DtmsIndustry }> = [
  { test: /coal|煤炭|\/13001/, industry: "煤炭" },
  { test: /steel|钢材|\/14001/, industry: "钢材" },
  { test: /car|车辆|汽车|\/15001/, industry: "车辆" },
  { test: /pulp|纸浆|\/18001/, industry: "纸浆" },
  { test: /farm|农产品|\/19001/, industry: "农产品" },
  { test: /standard|有色|\/24001/, industry: "有色" },
  { test: /other|其它|其他|\/25001/, industry: "其它" },
];

export interface PageContextHint {
  module?: DtmsModule;
  industry?: DtmsIndustry;
}

export function resolvePageContext(pageContext?: string): PageContextHint {
  if (!pageContext) return {};
  const lower = pageContext.toLowerCase();
  return {
    module: PAGE_CONTEXT_MODULE.find((r) => r.test.test(lower))?.module,
    industry: PAGE_CONTEXT_INDUSTRY.find((r) => r.test.test(lower))?.industry,
  };
}

export function isAllowedIndustry(value: string | undefined): value is DtmsIndustry {
  return !!value && (DTMS_INDUSTRIES as readonly string[]).includes(value);
}

export function industryFromSysId(sysId: unknown): DtmsIndustry | undefined {
  const id = typeof sysId === "string" ? Number(sysId) : sysId;
  if (typeof id !== "number" || !Number.isFinite(id)) return undefined;
  return SYS_ID_TO_INDUSTRY[id];
}

export function tablesForModules(modules: readonly DtmsModule[]): DtmsTable[] {
  const set = new Set(modules);
  return DTMS_TABLES.filter((t) => set.has(t.module));
}

export function moduleOfTable(tableName: string): DtmsModule | undefined {
  return DTMS_TABLES.find((t) => t.name === tableName.toLowerCase())?.module;
}

/** 从中台菜单 path/name/title 推断问数模块。 */
export function moduleFromMenuText(...parts: Array<string | undefined>): DtmsModule | undefined {
  const blob = parts.filter(Boolean).join(" ").toLowerCase();
  if (!blob) return undefined;
  return MODULE_MENU_PATTERNS.find((r) => r.test.test(blob))?.module;
}

export function detectIndustryInText(text: string): DtmsIndustry | undefined {
  return PAGE_CONTEXT_INDUSTRY.find((r) => r.test.test(text.toLowerCase()))?.industry;
}

export function detectModuleInText(text: string): DtmsModule | undefined {
  return PAGE_CONTEXT_MODULE.find((r) => r.test.test(text.toLowerCase()))?.module;
}

export function recommendedQuestions(industry?: string, modules?: readonly DtmsModule[]): string[] {
  const ind = isAllowedIndustry(industry) ? industry : "煤炭";
  const allowed = new Set(modules && modules.length > 0 ? modules : DTMS_MODULES);
  const out: string[] = [];
  if (allowed.has("合同")) out.push(`上个月${ind}采购合同金额合计是多少？`);
  if (allowed.has("发票")) out.push(`本月开票金额前 10 的发票`);
  if (allowed.has("付款")) out.push(`本月${ind}付款金额合计`);
  if (out.length === 0 && allowed.has("收款")) out.push(`本月${ind}收款金额合计`);
  if (out.length === 0) out.push(`上个月${ind}相关业务数据合计是多少？`);
  return out.slice(0, 3);
}

export function buildUnknownReplyText(industry?: string, modules?: readonly DtmsModule[]): string {
  const examples = recommendedQuestions(industry, modules).join("；");
  return `暂时无法处理该问题。我可以帮您查询 DTMS 业务数据，例如：${examples}`;
}

/** 给 LLM 的 DTMS schema 文本（仅用户有菜单权限的白名单表）。 */
export function buildDtmsSchemaPrompt(
  question: string,
  pageContext?: string,
  allowedModules?: readonly DtmsModule[],
): string {
  const catalog =
    allowedModules && allowedModules.length > 0 ? tablesForModules(allowedModules) : DTMS_TABLES;
  const hint = resolvePageContext(pageContext);
  const preferred =
    hint.module && catalog.some((t) => t.module === hint.module)
      ? catalog.filter((t) => t.module === hint.module)
      : catalog.filter((t) =>
          t.columns.some((c) => question.includes(t.title) || question.includes(c.title)),
        );
  const focus = preferred.length > 0 ? preferred : catalog;
  const focusSet = new Set(focus.map((t) => t.name));

  const render = (table: DtmsTable): string => {
    const cols = table.columns
      .filter((c) => !c.sensitive)
      .map((c) => `  - \`${c.name}\` ${c.title} (${c.type})`)
      .join("\n");
    return `### \`${table.name}\` ${table.title}\n${table.description}\n${cols}`;
  };

  const focused = catalog
    .filter((t) => focusSet.has(t.name))
    .map(render)
    .join("\n\n");
  const others = catalog
    .filter((t) => !focusSet.has(t.name))
    .map((t) => `- \`${t.name}\` ${t.title}`)
    .join("\n");

  return [
    "只允许查询下列 DTMS 业务表，表名必须原样使用（含 dtms_ 前缀）。",
    "禁止查询 NEW-API / 运营平台数据（users、logs、tokens、quota、models 等）。",
    "不要在 SQL 中写行业/组织权限条件（执行器会强制注入）。时间字段为 DATE，按自然日过滤。",
    "",
    "## 优先使用的表",
    focused,
    others ? `\n## 其它白名单表（仅当问题明确相关时使用）\n${others}` : "",
  ].join("\n");
}
