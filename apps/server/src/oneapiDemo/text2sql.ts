import {
  renderSkeleton,
  renderTableSchemaTiered,
  searchTables,
  type SchemaCatalog,
  type TableCatalog,
} from "@open-agent-tools/schema-catalog";
import {
  executeQuerySqlWithConnection,
  validateQuerySql,
} from "../function_tools/sqlQueryBuiltin.js";
import { extractJson } from "../jsonExtraction.js";
import { buildClarification, type Clarification } from "@open-agent-tools/query-resolver";
import { createLlmClient, type LlmClient } from "../providers/clients/index.js";
import { getDefaultProvider, getProvider, type ProviderWithKey } from "../providers/store.js";
import { detectIntent, detectRowLimitIntent, rowLimitClarifying } from "../schema-inject.js";
import {
  exportQuerySubgraph,
  getSchemaGraph,
  inferReferences,
  loadSchemaCatalog,
  matchTableNames,
} from "../schemaSources/runtime.js";
import type { SchemaSemanticProfile, SchemaSourceWithSecret } from "../schemaSources/store.js";
import { resolveSchemaSource } from "../schemaSources/resolve.js";
import { selectTablesSemantically, semanticSelectorEnabled } from "../schemaSources/semantic.js";
import {
  createQueryAudit,
  type QueryAuditCreateOptions,
  type QueryProgressEvent,
  type QueryStep,
} from "../observatory/queryAudit.js";
import {
  assessQueryResult,
  summarizeAssessment,
  type QueryResultAssessment,
  type QueryResultBaseline,
  type ResultCheck,
} from "./resultChecks.js";
import { loadResultBaseline, recordResultBaseline } from "./resultBaselines.js";
import {
  currentUsage,
  currentUsageWorkspaceId,
  trackUsage,
  type UsageSnapshot,
} from "../usageTracking.js";
import { formatHistoryText } from "../promptHistory.js";

const ONEAPI_INTENT_TABLES: Record<string, string[]> = {
  log_query: ["logs"],
  user_query: ["users", "tokens", "logs"],
  token_query: ["tokens", "users"],
  channel_query: ["channels", "channel_keys", "abilities"],
  order_query: ["orders", "top_ups", "payments"],
  quota_query: ["quota_data", "statistics", "users"],
  redemption_query: ["redemptions"],
  model_query: ["prices", "abilities", "channels"],
};

const FROM_JOIN =
  /\b(?:from|join)\s+(?:(?:[`"]?([a-zA-Z_][a-zA-Z0-9_$]*)[`"]?)\.)?[`"]?([a-zA-Z_][a-zA-Z0-9_$]*)[`"]?/gi;

export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ObservatoryQueryResult {
  usage: UsageSnapshot;
  auditId: string;
  steps: QueryStep[];
  sourceId: string;
  question: string;
  /** 仅结构化澄清时的当前轮补充文本。 */
  turnQuestion?: string;
  intent?: string;
  selectedTables: string[];
  schemaPrompt: string;
  graph: Awaited<ReturnType<typeof exportQuerySubgraph>>["graph"];
  seeds: string[];
  formattedGraph: string;
  sql?: string;
  originalQuestion?: string;
  generatedSql?: string;
  executedSql?: string;
  clarification?: Clarification;
  clarifying?: string;
  rows?: Record<string, unknown>[];
  truncated?: boolean;
  /** C4 结果校验预警:结果照常返回,由前端与审计决定如何提示。 */
  checks?: ResultCheck[];
  error?: string;
  durationMs: number;
}

export interface ObservatoryRunOptions {
  audit: QueryAuditCreateOptions;
  /** 真实查询文本;clarification 续问时与首问的 originalQuestion 分开记录。 */
  turnQuestion?: string;
  /** rerun 只跳过生成阶段,仍执行 Schema 校验和只读执行。 */
  rerun?: {
    sql: string;
    generatedSql?: string | null;
    sqlSource: "edited" | "original";
  };
  /** rerun 必须显式提供权限钩子;默认查询链路不启用。 */
  validateRerunSql?: (sql: string, catalog: SchemaCatalog, graph: unknown) => void | Promise<void>;
}

function resolveLlm(): { llm: LlmClient; model: string; provider: ProviderWithKey } | null {
  const providerId = process.env.AI_QUERY_PROVIDER_ID;
  const provider: ProviderWithKey | null = providerId
    ? getProvider(providerId, { requireEnabled: true })
    : getDefaultProvider({ requireEnabled: true });
  if (!provider) return null;
  return {
    provider,
    llm: createLlmClient({ ...provider, apiKey: provider.apiKey ?? "ollama" }),
    model: process.env.AI_QUERY_MODEL || provider.models[0] || "gpt-4o-mini",
  };
}

/**
 * 结果校验(C4):对已取回的行做保守规则校验,并把本次观测记为下次查询的基线。
 * 基线读写失败不影响查询主链路;校验只产出预警,不改变结果本身。
 */
function resultChecksFor(
  sourceId: string,
  question: string,
  rows: Record<string, unknown>[],
  truncated: boolean,
): QueryResultAssessment {
  let baseline: QueryResultBaseline | null = null;
  try {
    baseline = loadResultBaseline(sourceId, question);
  } catch {
    // 基线读取失败按「无基线」处理,不能让校验反过来拖垮查询。
  }
  const assessment = assessQueryResult({ rows, truncated, baseline });
  try {
    if (rows.length > 0) recordResultBaseline(sourceId, question, rows);
  } catch {
    // 基线写入失败只影响下次校验,本次结果照常返回。
  }
  return assessment;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export async function selectTables(
  question: string,
  catalog: SchemaCatalog,
  profile: SchemaSemanticProfile,
  graph: Awaited<ReturnType<typeof getSchemaGraph>>,
  sourceId?: string,
): Promise<string[]> {
  const names = catalog.tables.map((table) => table.table.name);
  const directHits = matchTableNames(question, names, profile);
  const commentHits = catalog.tables
    .filter((table) => table.table.comment && question.includes(table.table.comment))
    .map((table) => table.table.name);
  if (profile === "oneapi") {
    const intent = detectIntent(question);
    if (intent && ONEAPI_INTENT_TABLES[intent]) {
      return unique([...(ONEAPI_INTENT_TABLES[intent] ?? []), ...directHits, ...commentHits])
        .filter((name) => names.includes(name))
        .slice(0, 4);
    }
  }
  const explicit = unique([...directHits, ...commentHits]);
  if (explicit.length > 0) return explicit.slice(0, 4);

  // 语义选表（SCHEMA_SEMANTIC_SELECTOR 启用时）:RAG 召回候选表,命中即返回。
  if (sourceId && semanticSelectorEnabled()) {
    const semantic = await selectTablesSemantically(sourceId, question, catalog, 4);
    if (semantic.length > 0) return semantic;
  }

  const retrieved = await graph.retrieve(question, { maxHops: 1, maxNodes: 24, seedLimit: 8 });
  const fromGraph = (retrieved.seeds ?? [])
    .filter((entity) => entity.type === "table")
    .map((entity) => entity.name);
  if (fromGraph.length > 0) return unique(fromGraph).slice(0, 4);
  return searchTables(catalog, question, 4).map((hit) => hit.table.table.name);
}

export function renderSelectedSchema(
  catalog: SchemaCatalog,
  tableNames: string[],
  profile: SchemaSemanticProfile = "generic",
): string {
  const byName = new Map(catalog.tables.map((table) => [table.table.name, table]));
  const selected = tableNames
    .map((name) => byName.get(name))
    .filter((table): table is TableCatalog => table !== undefined);
  const scopedCatalog: SchemaCatalog = {
    ...catalog,
    tables: selected.length > 0 ? selected : catalog.tables,
  };
  const skeleton = renderSkeleton(scopedCatalog);
  const detail = selected
    .map((table) => renderTableSchemaTiered(table, ["required", "common", "full"]))
    .join("\n\n");
  const refs = inferReferences(catalog, profile)
    .filter(
      (relation) =>
        tableNames.includes(relation.fromTable) && tableNames.includes(relation.toTable),
    )
    .map(
      (relation) =>
        `- ${relation.fromTable}.${relation.fromColumn} → ${relation.toTable}.${relation.toColumn}`,
    )
    .join("\n");
  const rendered = [
    skeleton,
    detail ? `\n--- 本次查询相关表 ---\n${detail}` : "",
    refs ? `\n关联:\n${refs}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return catalog.source === "postgresql" ? rendered.replace(/`([^`]+)`/g, '"$1"') : rendered;
}

function extractTableRefs(sql: string): Array<{ schema?: string; table: string }> {
  const refs = new Map<string, { schema?: string; table: string }>();
  for (const match of sql.matchAll(FROM_JOIN)) {
    const schema = match[1]?.toLowerCase();
    const table = match[2]?.toLowerCase();
    if (!table) continue;
    refs.set(`${schema ?? ""}.${table}`, { ...(schema ? { schema } : {}), table });
  }
  return [...refs.values()];
}

export function validateSchemaSql(sql: string, catalog: SchemaCatalog): void {
  validateQuerySql(sql);
  const referenced = extractTableRefs(sql);
  if (referenced.length === 0) throw new Error("SQL 未引用任何表");
  const allowed = new Map<string, Set<string>>();
  for (const table of catalog.tables) {
    const schemas = allowed.get(table.table.name.toLowerCase()) ?? new Set<string>();
    schemas.add(table.table.schema.toLowerCase());
    allowed.set(table.table.name.toLowerCase(), schemas);
  }
  for (const ref of referenced) {
    const schemas = allowed.get(ref.table);
    if (!schemas) throw new Error(`表不属于当前 Schema 源:${ref.table}`);
    if (ref.schema && !schemas.has(ref.schema)) {
      throw new Error(`禁止跨 Schema 查询:${ref.schema}.${ref.table}`);
    }
  }
}

function systemPrompt(source: SchemaSourceWithSecret): string {
  const identifierRule =
    source.connector === "postgresql"
      ? "表名和列名只能来自下方 schema，需要引用时使用双引号；"
      : "表名和列名只能来自下方 schema，需要引用时使用反引号；";
  const base =
    `你是“${source.name}”的 text-to-SQL 助手,把用户问题转成一条只读 SELECT。\n` +
    "规则:\n" +
    `1) ${identifierRule}\n` +
    "2) 只输出单条 SELECT，不要 UNION、注释或多语句；\n" +
    "3) 聚合列使用清晰的中文别名;\n" +
    "4) 条数：用户指定前 N 条、最近 N 条或 TOP N 时必须写 LIMIT N，且 N 不超过 100；用户明确要求全部、所有或全量时不要写 LIMIT；未指定条数时不要猜测，返回 clarifying；\n" +
    "5) 缺少必要业务口径时才追问;用户补充条数或口径后必须继续生成 SQL。\n";
  const profileRules =
    source.semanticProfile === "oneapi"
      ? "业务同义词：权重=weight，额度=quota，令牌=tokens.key/name，渠道=channels；时间戳通常为 Unix 秒。\n"
      : "字段类型、注释、枚举和关系以 schema 内容为准,不得臆造业务口径。\n";
  return (
    base +
    profileRules +
    "只输出 JSON：\n" +
    '能写 SQL → {"sql":"SELECT ..."}\n' +
    '缺少口径 → {"clarifying":"请补充需要的时间范围或统计口径"}'
  );
}

async function generateSql(
  llm: LlmClient,
  model: string,
  source: SchemaSourceWithSecret,
  question: string,
  schema: string,
  history: HistoryTurn[],
  rowLimit: ReturnType<typeof detectRowLimitIntent>,
): Promise<{ sql?: string; clarifying?: string }> {
  const historyText = formatHistoryText(history, 6);
  const response = await llm.complete({
    model,
    messages: [
      { role: "system", content: systemPrompt(source) },
      {
        role: "user",
        content:
          `${schema}\n\n` +
          (historyText ? `最近对话:\n${historyText}\n\n` : "") +
          `条数口径:${
            rowLimit.kind === "limited"
              ? `用户要求 ${rowLimit.limit} 条,SQL 必须包含 LIMIT ${rowLimit.limit}`
              : "用户要求查询全部,SQL 不要包含 LIMIT"
          }\n` +
          `本次问题:${question}`,
      },
    ],
  });
  const parsed = extractJson(response.content);
  return {
    sql: typeof parsed?.sql === "string" && parsed.sql.trim() ? parsed.sql.trim() : undefined,
    clarifying:
      typeof parsed?.clarifying === "string" && parsed.clarifying.trim()
        ? parsed.clarifying.trim()
        : undefined,
  };
}

export async function runSchemaText2Sql(
  sourceId: string | undefined,
  question: string,
  history: HistoryTurn[] = [],
  onProgress?: (event: QueryProgressEvent) => void,
  options: ObservatoryRunOptions = { audit: {} },
): Promise<ObservatoryQueryResult> {
  return trackUsage({ source: "sql_query", workspaceId: options.audit.workspace }, () =>
    runSchemaText2SqlCore(sourceId, question, history, onProgress, options),
  );
}

async function runSchemaText2SqlCore(
  sourceId: string | undefined,
  question: string,
  history: HistoryTurn[],
  onProgress: ((event: QueryProgressEvent) => void) | undefined,
  options: ObservatoryRunOptions,
): Promise<ObservatoryQueryResult> {
  const audit = createQueryAudit(sourceId, question, history, onProgress, {
    ...options.audit,
    workspace: options.audit.workspace ?? currentUsageWorkspaceId(),
  });
  const result: ObservatoryQueryResult = {
    usage: currentUsage(),
    auditId: audit.record.id,
    steps: audit.record.steps,
    sourceId: sourceId ?? "",
    question: options.turnQuestion ?? question,
    turnQuestion: options.turnQuestion,
    selectedTables: [],
    schemaPrompt: "",
    graph: { nodes: [], edges: [], stats: { entities: 0, relations: 0 } },
    seeds: [],
    formattedGraph: "",
    durationMs: 0,
    originalQuestion: options.audit.originalQuestion ?? question,
    generatedSql: options.audit.generatedSql ?? undefined,
    executedSql: options.audit.executedSql ?? undefined,
  };
  try {
    audit.start("source", { sourceId: sourceId ?? null });
    const source = resolveSchemaSource(sourceId);
    audit.addSecret(source.connectionString);
    const password = new URL(source.connectionString).password;
    audit.addSecret(password);
    try {
      audit.addSecret(decodeURIComponent(password));
    } catch {
      // The URL parser also accepts passwords containing a literal percent sign.
    }
    result.sourceId = source.id;
    audit.patch({ sourceId: source.id, sourceName: source.name });
    audit.complete("source", `已选择 ${source.name}`, {
      sourceId: source.id,
      name: source.name,
      connector: source.connector,
    });

    audit.start("schema", { sourceId: source.id });
    const catalog = await loadSchemaCatalog(source.id);
    const graph = await getSchemaGraph(source.id);
    audit.complete("schema", `已加载 ${catalog.tables.length} 张表`, {
      database: catalog.database,
      tableCount: catalog.tables.length,
    });

    if (options.rerun) {
      result.originalQuestion = options.audit.originalQuestion ?? question;
      result.generatedSql = options.rerun.generatedSql ?? undefined;
      result.executedSql = options.rerun.sql;
      result.sql = options.rerun.sql;
      result.selectedTables = extractTableRefs(options.rerun.sql).map((ref) => ref.table);
      audit.patch({
        originalQuestion: result.originalQuestion,
        generatedSql: result.generatedSql,
        executedSql: result.executedSql,
        sql: result.sql,
        selectedTables: result.selectedTables,
      });
      // 重跑没有生成阶段,显式按 skipped 记录,避免审计 UI 一直显示 pending。
      const generationStep = audit.record.steps.find((step) => step.id === "generation");
      if (generationStep) generationStep.status = "skipped";
      // Persist the skipped marker before validation starts; otherwise validation.publish overwrites it.
      audit.persist();
      audit.start("validation", { sql: options.rerun.sql, sqlSource: options.rerun.sqlSource });
      if (options.validateRerunSql) {
        await options.validateRerunSql(options.rerun.sql, catalog, graph);
      } else {
        validateSchemaSql(options.rerun.sql, catalog);
      }
      audit.complete("validation", "已通过只读、单语句及 Schema 范围校验");
      audit.start("execution", { sql: options.rerun.sql, sourceId: source.id });
      const executed = await executeQuerySqlWithConnection(
        options.rerun.sql,
        source.connectionString,
        [],
        {
          connector: source.connector,
          database: source.databaseName ?? undefined,
          schema: source.schemaName ?? undefined,
        },
      );
      if (!executed.ok) throw new Error(executed.error ?? "SQL 执行失败");
      const rows = (executed.rows ?? []) as Record<string, unknown>[];
      const truncated = executed.truncated === true;
      audit.complete(
        "execution",
        truncated ? `查询返回 ${rows.length} 行,已达展示上限` : `查询返回 ${rows.length} 行`,
        { rowCount: rows.length, truncated, durationMs: executed.durationMs },
      );
      audit.start("output", { rowCount: rows.length, truncated });
      result.rows = rows;
      result.truncated = truncated;
      const assessment = resultChecksFor(
        source.id,
        result.originalQuestion ?? question,
        rows,
        truncated,
      );
      result.checks = assessment.checks;
      audit.patch({ rowCount: rows.length, resultPreview: rows });
      audit.complete(
        "output",
        [
          rows.length
            ? truncated
              ? `已输出前 ${rows.length} 行,结果已截断`
              : `已输出 ${rows.length} 行结果`
            : "查询完成,无匹配数据",
          summarizeAssessment(assessment),
        ]
          .filter(Boolean)
          .join(";"),
        {
          rowCount: rows.length,
          truncated,
          columns: Object.keys(rows[0] ?? {}),
          sqlSource: options.rerun.sqlSource,
          resultChecks: assessment.checks,
        },
      );
      const finished = audit.finish("succeeded");
      return { ...result, steps: finished.steps, durationMs: finished.durationMs };
    }

    audit.start("retrieval", { question, history });
    const lookup = [question, ...history.map((turn) => turn.content)].join("\n");
    result.selectedTables = await selectTables(
      lookup,
      catalog,
      source.semanticProfile,
      graph,
      source.id,
    );
    result.schemaPrompt = renderSelectedSchema(
      catalog,
      result.selectedTables,
      source.semanticProfile,
    );
    const graphView = await exportQuerySubgraph(graph, question, source.semanticProfile);
    result.graph = graphView.graph;
    result.seeds = graphView.seeds.map((seed) => seed.name);
    result.formattedGraph = graphView.formatted;
    result.intent = source.semanticProfile === "oneapi" ? detectIntent(question) : undefined;
    const rowLimit = detectRowLimitIntent(
      [
        ...history.filter((turn) => turn.role === "user").map((turn) => turn.content),
        question,
      ].join("\n"),
    );
    result.intent = [result.intent, `row_limit:${rowLimit.kind}`].filter(Boolean).join(",");
    audit.patch({ selectedTables: result.selectedTables, rowLimit });
    audit.complete("retrieval", `选中 ${result.selectedTables.length} 张相关表`, {
      selectedTables: result.selectedTables,
      schemaPrompt: result.schemaPrompt,
      seeds: result.seeds,
      rowLimit,
    });
    if (rowLimit.kind === "unspecified") {
      const text = rowLimitClarifying();
      const built = buildClarification({
        question,
        clarifying: text,
        history,
        context: {
          originalQuestion: result.originalQuestion,
          round: history.filter((turn) => turn.role === "assistant").length,
        },
      });
      if (built.repeated) {
        throw new Error(`已追问“${built.slot.label}”，请直接补充具体值后再查询`);
      }
      result.clarifying = built.clarification.clarifying;
      result.clarification = built.clarification;
      audit.patch({
        clarifying: result.clarifying,
        clarification: result.clarification,
        rowLimit,
      });
      audit.complete("generation", "需要确认查询条数", {
        clarifying: result.clarifying,
        clarification: result.clarification,
        rowLimit,
      });
      const finished = audit.clarify(result.clarification);
      return { ...result, steps: finished.steps, durationMs: finished.durationMs };
    }

    audit.start("generation", { question, history, schemaPrompt: result.schemaPrompt, rowLimit });
    const llmPack = resolveLlm();
    if (!llmPack) throw new Error("未配置可用 LLM Provider（Studio 设置里添加并设为默认）");
    audit.addSecret(llmPack.provider.apiKey ?? "");
    audit.patch({ providerId: llmPack.provider.id, model: llmPack.model });
    const generated = await generateSql(
      llmPack.llm,
      llmPack.model,
      source,
      question,
      result.schemaPrompt,
      history,
      rowLimit,
    );
    if (generated.clarifying && !generated.sql) {
      const built = buildClarification({
        question,
        clarifying: generated.clarifying,
        history,
        context: {
          originalQuestion: result.originalQuestion,
          round: history.filter((turn) => turn.role === "assistant").length,
        },
      });
      if (built.repeated) {
        throw new Error(`已追问“${built.slot.label}”，请直接补充具体值后再查询`);
      }
      result.clarifying = built.clarification.clarifying;
      result.clarification = built.clarification;
      audit.patch({ clarifying: result.clarifying, clarification: result.clarification });
      audit.complete("generation", "需要补充查询口径", {
        clarifying: result.clarifying,
        clarification: result.clarification,
      });
      const finished = audit.clarify(result.clarification);
      return { ...result, steps: finished.steps, durationMs: finished.durationMs };
    }
    if (!generated.sql) throw new Error("模型未生成 SQL");
    result.sql = generated.sql;
    result.generatedSql = generated.sql;
    result.executedSql = generated.sql;
    audit.patch({ sql: generated.sql, generatedSql: generated.sql, executedSql: generated.sql });
    audit.complete("generation", "SQL 已生成", {
      sql: generated.sql,
      model: llmPack.model,
      sqlSource: "generated",
    });

    audit.start("validation", { sql: generated.sql });
    validateSchemaSql(generated.sql, catalog);
    audit.complete("validation", "已通过只读、单语句及 Schema 范围校验");

    audit.start("execution", { sql: generated.sql, sourceId: source.id });
    const executed = await executeQuerySqlWithConnection(
      generated.sql,
      source.connectionString,
      [],
      {
        connector: source.connector,
        database: source.databaseName ?? undefined,
        schema: source.schemaName ?? undefined,
      },
    );
    if (!executed.ok) throw new Error(executed.error ?? "SQL 执行失败");
    const rows = (executed.rows ?? []) as Record<string, unknown>[];
    const truncated = executed.truncated === true;
    audit.complete(
      "execution",
      truncated ? `查询返回 ${rows.length} 行,已达展示上限` : `查询返回 ${rows.length} 行`,
      {
        rowCount: rows.length,
        truncated,
        durationMs: executed.durationMs,
      },
    );

    audit.start("output", { rowCount: rows.length, truncated });
    result.rows = rows;
    result.truncated = truncated;
    const assessment = resultChecksFor(
      source.id,
      result.originalQuestion ?? question,
      rows,
      truncated,
    );
    result.checks = assessment.checks;
    audit.patch({ rowCount: rows.length, resultPreview: rows });
    audit.complete(
      "output",
      [
        rows.length
          ? truncated
            ? `已输出前 ${rows.length} 行,结果已截断`
            : `已输出 ${rows.length} 行结果`
          : "查询完成,无匹配数据",
        summarizeAssessment(assessment),
      ]
        .filter(Boolean)
        .join(";"),
      {
        rowCount: rows.length,
        truncated,
        columns: Object.keys(rows[0] ?? {}),
        sqlSource: "generated",
        resultChecks: assessment.checks,
      },
    );
    const finished = audit.finish("succeeded");
    return { ...result, steps: finished.steps, durationMs: finished.durationMs };
  } catch (error) {
    const finished = audit.finish("failed", error instanceof Error ? error.message : String(error));
    return {
      ...result,
      steps: finished.steps,
      error: finished.error ?? "查询失败",
      durationMs: finished.durationMs,
    };
  } finally {
    audit.patch({ usage: { ...result.usage } });
  }
}
