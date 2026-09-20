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
import { createLlmClient, type LlmClient } from "../providers/clients/index.js";
import { getDefaultProvider, getProvider, type ProviderWithKey } from "../providers/store.js";
import { detectIntent } from "../schema-inject.js";
import {
  exportQuerySubgraph,
  getSchemaGraph,
  inferReferences,
  loadSchemaCatalog,
  matchTableNames,
} from "../schemaSources/runtime.js";
import {
  getDefaultSchemaSource,
  getSchemaSource,
  type SchemaSemanticProfile,
  type SchemaSourceWithSecret,
} from "../schemaSources/store.js";

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
  sourceId: string;
  question: string;
  intent?: string;
  selectedTables: string[];
  schemaPrompt: string;
  graph: Awaited<ReturnType<typeof exportQuerySubgraph>>["graph"];
  seeds: string[];
  formattedGraph: string;
  sql?: string;
  clarifying?: string;
  rows?: Record<string, unknown>[];
  error?: string;
  durationMs: number;
}

function resolveSource(sourceId?: string): SchemaSourceWithSecret {
  const source = sourceId
    ? getSchemaSource(sourceId, { requireEnabled: true })
    : getDefaultSchemaSource({ requireEnabled: true });
  if (!source)
    throw new Error(
      sourceId ? "schema source not found or disabled" : "no enabled schema source configured",
    );
  return source;
}

function resolveLlm(): { llm: LlmClient; model: string } | null {
  const providerId = process.env.AI_QUERY_PROVIDER_ID;
  const provider: ProviderWithKey | null = providerId
    ? getProvider(providerId, { requireEnabled: true })
    : getDefaultProvider({ requireEnabled: true });
  if (!provider) return null;
  return {
    llm: createLlmClient({ ...provider, apiKey: provider.apiKey ?? "ollama" }),
    model: process.env.AI_QUERY_MODEL || provider.models[0] || "gpt-4o-mini",
  };
}

function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export async function selectTables(
  question: string,
  catalog: SchemaCatalog,
  profile: SchemaSemanticProfile,
  graph: Awaited<ReturnType<typeof getSchemaGraph>>,
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
    refs ? `\n关联：\n${refs}` : "",
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
    if (!schemas) throw new Error(`表不属于当前 Schema 源：${ref.table}`);
    if (ref.schema && !schemas.has(ref.schema)) {
      throw new Error(`禁止跨 Schema 查询：${ref.schema}.${ref.table}`);
    }
  }
}

function systemPrompt(source: SchemaSourceWithSecret): string {
  const identifierRule =
    source.connector === "postgresql"
      ? "表名和列名只能来自下方 schema，需要引用时使用双引号；"
      : "表名和列名只能来自下方 schema，需要引用时使用反引号；";
  const base =
    `你是“${source.name}”的 text-to-SQL 助手，把用户问题转成一条只读 SELECT。\n` +
    "规则：\n" +
    `1) ${identifierRule}\n` +
    "2) 只输出单条 SELECT，不要 UNION、注释或多语句；\n" +
    "3) 聚合列使用清晰的中文别名；不要自行添加 LIMIT，执行器会统一截断；\n" +
    "4) 缺少必要业务口径时才追问；用户补充后必须继续生成 SQL。\n";
  const profileRules =
    source.semanticProfile === "oneapi"
      ? "业务同义词：权重=weight，额度=quota，令牌=tokens.key/name，渠道=channels；时间戳通常为 Unix 秒。\n"
      : "字段类型、注释、枚举和关系以 schema 内容为准，不得臆造业务口径。\n";
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
): Promise<{ sql?: string; clarifying?: string }> {
  const historyText = history
    .slice(-6)
    .map((turn) => `${turn.role === "user" ? "用户" : "助手"}: ${turn.content}`)
    .join("\n");
  const response = await llm.complete({
    model,
    messages: [
      { role: "system", content: systemPrompt(source) },
      {
        role: "user",
        content:
          `${schema}\n\n` +
          (historyText ? `最近对话：\n${historyText}\n\n` : "") +
          `本次问题：${question}`,
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
): Promise<ObservatoryQueryResult> {
  const started = Date.now();
  const source = resolveSource(sourceId);
  const catalog = await loadSchemaCatalog(source.id);
  const graph = await getSchemaGraph(source.id);
  const lookup = [question, ...history.map((turn) => turn.content)].join("\n");
  const selectedTables = await selectTables(lookup, catalog, source.semanticProfile, graph);
  const schemaPrompt = renderSelectedSchema(catalog, selectedTables, source.semanticProfile);
  const graphView = await exportQuerySubgraph(graph, question, source.semanticProfile);
  const intent = source.semanticProfile === "oneapi" ? detectIntent(question) : undefined;
  const base = {
    sourceId: source.id,
    question,
    ...(intent ? { intent } : {}),
    selectedTables,
    schemaPrompt,
    graph: graphView.graph,
    seeds: graphView.seeds.map((seed) => seed.name),
    formattedGraph: graphView.formatted,
  };

  const llmPack = resolveLlm();
  if (!llmPack) {
    return {
      ...base,
      error: "未配置可用 LLM Provider（Studio 设置里添加并设为默认）",
      durationMs: Date.now() - started,
    };
  }

  const generated = await generateSql(
    llmPack.llm,
    llmPack.model,
    source,
    question,
    schemaPrompt,
    history,
  );
  if (generated.clarifying && !generated.sql) {
    return { ...base, clarifying: generated.clarifying, durationMs: Date.now() - started };
  }
  if (!generated.sql) {
    return { ...base, error: "模型未生成 SQL", durationMs: Date.now() - started };
  }

  try {
    validateSchemaSql(generated.sql, catalog);
  } catch (error) {
    return {
      ...base,
      sql: generated.sql,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - started,
    };
  }

  const executed = await executeQuerySqlWithConnection(generated.sql, source.connectionString, [], {
    connector: source.connector,
    database: source.databaseName ?? undefined,
    schema: source.schemaName ?? undefined,
  });
  return {
    ...base,
    sql: generated.sql,
    rows: executed.ok ? ((executed.rows ?? []) as Record<string, unknown>[]) : undefined,
    error: executed.ok ? undefined : executed.error,
    durationMs: Date.now() - started,
  };
}
