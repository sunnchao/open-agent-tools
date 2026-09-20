import { createHash } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  collectMysqlCatalog,
  collectPostgresCatalog,
  enrichNewApiCatalog,
  type RelationMeta,
  type SchemaCatalog,
} from "@open-agent-tools/schema-catalog";
import {
  KnowledgeGraph,
  entityId,
  relationId,
  type Entity,
  type GraphExport,
  type Relation,
} from "@open-agent-tools/rag/graph";
import { getDbPath } from "../db.js";
import { logTrace } from "../trace.js";
import {
  getDefaultSchemaSource,
  getSchemaSource,
  type SchemaSemanticProfile,
  type SchemaSourceWithSecret,
  updateSchemaSourceSyncState,
} from "./store.js";

interface RuntimeState {
  catalog?: SchemaCatalog;
  graph?: KnowledgeGraph;
  buildPromise?: Promise<KnowledgeGraph>;
}

const states = new Map<string, RuntimeState>();

const ONEAPI_ALIASES: Record<string, string[]> = {
  users: ["用户", "账号", "注册用户"],
  logs: ["日志", "消费日志", "调用记录", "用量", "使用记录"],
  tokens: ["令牌", "api key", "密钥"],
  channels: ["渠道", "通道", "供应商", "上游"],
  orders: ["订单"],
  top_ups: ["充值", "充值单"],
  payments: ["支付", "支付渠道"],
  quota_data: ["额度", "消耗", "余额"],
  statistics: ["统计", "日报"],
  redemptions: ["兑换码", "充值码"],
  prices: ["价格", "定价", "模型价格"],
  abilities: ["模型能力", "模型列表"],
  midjourneys: ["绘画", "midjourney"],
  user_groups: ["用户组", "分组"],
  channel_keys: ["渠道密钥"],
};

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

function runtimeFor(sourceId: string): RuntimeState {
  const current = states.get(sourceId) ?? {};
  states.set(sourceId, current);
  return current;
}

export async function loadSchemaCatalog(sourceId?: string): Promise<SchemaCatalog> {
  const source = resolveSource(sourceId);
  const state = runtimeFor(source.id);
  if (state.catalog) return state.catalog;
  const collect = source.connector === "postgresql" ? collectPostgresCatalog : collectMysqlCatalog;
  const catalog = await collect({
    connectionString: source.connectionString,
    database: source.databaseName ?? undefined,
    schema: source.schemaName ?? undefined,
    tableFilter: source.tableFilter,
    skipSamples: true,
  });
  state.catalog = source.semanticProfile === "oneapi" ? enrichNewApiCatalog(catalog) : catalog;
  return state.catalog;
}

export function schemaGraphDbPath(sourceId: string): string {
  const digest = createHash("sha256").update(sourceId).digest("hex").slice(0, 20);
  const file = resolve(dirname(getDbPath()), `schema-graph-${digest}.db`);
  mkdirSync(dirname(file), { recursive: true });
  return file;
}

export async function getSchemaGraph(sourceId?: string): Promise<KnowledgeGraph> {
  const source = resolveSource(sourceId);
  const state = runtimeFor(source.id);
  if (state.graph) return state.graph;
  state.buildPromise ??= buildSchemaGraph(source).catch((error) => {
    updateSchemaSourceSyncState(source.id, {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    });
    states.delete(source.id);
    throw error;
  });
  return state.buildPromise;
}

export function invalidateSchemaSource(sourceId: string): void {
  const state = states.get(sourceId);
  state?.graph?.close();
  states.delete(sourceId);
}

export function removeSchemaSourceRuntime(sourceId: string): void {
  invalidateSchemaSource(sourceId);
  const file = schemaGraphDbPath(sourceId);
  if (existsSync(file)) unlinkSync(file);
}

export async function rebuildSchemaGraph(sourceId?: string): Promise<KnowledgeGraph> {
  const source = resolveSource(sourceId);
  invalidateSchemaSource(source.id);
  return getSchemaGraph(source.id);
}

async function buildSchemaGraph(source: SchemaSourceWithSecret): Promise<KnowledgeGraph> {
  updateSchemaSourceSyncState(source.id, { status: "syncing", error: null });
  const catalog = await loadSchemaCatalog(source.id);
  const graph = new KnowledgeGraph({ dbPath: schemaGraphDbPath(source.id) });
  const sourceKey = `schema-source:${source.id}`;
  graph.store.removeBySource(sourceKey);
  graph.store.removeSourceRecord(sourceKey);
  graph.store.markSource(sourceKey, { status: "building", chunks: catalog.tables.length });

  const refs = inferReferences(catalog, source.semanticProfile);
  const tableEntities = new Map<string, Entity>();
  for (const table of catalog.tables) {
    const name = table.table.name;
    const entity: Entity = {
      id: entityId(name, "table"),
      name,
      type: "table",
      props: {
        comment: table.table.comment ?? "",
        rows: String(table.table.approxRows ?? 0),
        columns: String(table.columns.length),
      },
    };
    graph.store.upsertEntity(entity);
    graph.store.linkEntitySource(entity.id, sourceKey);
    if (table.table.comment) graph.store.addAlias(entity.id, table.table.comment);
    for (const alias of aliasesFor(name, source.semanticProfile))
      graph.store.addAlias(entity.id, alias);
    tableEntities.set(name, entity);
  }

  let relationCount = 0;
  for (const ref of refs) {
    const src = tableEntities.get(ref.fromTable);
    const dst = tableEntities.get(ref.toTable);
    if (!src || !dst) continue;
    const colName = `${ref.fromTable}.${ref.fromColumn}`;
    const columnEntity: Entity = {
      id: entityId(colName, "column"),
      name: colName,
      type: "column",
      props: { table: ref.fromTable, column: ref.fromColumn, to: `${ref.toTable}.${ref.toColumn}` },
    };
    graph.store.upsertEntity(columnEntity);
    graph.store.linkEntitySource(columnEntity.id, sourceKey);
    graph.store.addAlias(columnEntity.id, ref.fromColumn);
    const chunkId = `${sourceKey}:${ref.fromTable}`;
    for (const relation of [
      makeRel(src, "has_column", columnEntity, chunkId, sourceKey),
      makeRel(columnEntity, "references", dst, chunkId, sourceKey),
      makeRel(src, ref.fromColumn, dst, chunkId, sourceKey),
    ]) {
      graph.store.upsertRelation(relation);
      relationCount += 1;
    }
  }

  graph.store.markSource(sourceKey, {
    status: "ready",
    entities: tableEntities.size + refs.length,
    relations: relationCount,
    chunks: catalog.tables.length,
    error: "",
  });
  updateSchemaSourceSyncState(source.id, {
    status: "ready",
    lastSyncedAt: new Date().toISOString(),
    error: null,
    tableCount: catalog.tables.length,
    relationCount: refs.length,
  });
  runtimeFor(source.id).graph = graph;
  logTrace("schema_source.graph_ready", {
    sourceId: source.id,
    database: catalog.database,
    tables: catalog.tables.length,
    refs: refs.length,
  });
  return graph;
}

function makeRel(
  src: Entity,
  relType: string,
  dst: Entity,
  chunkId: string,
  source: string,
): Relation {
  return {
    id: relationId(src.id, relType, dst.id),
    srcId: src.id,
    dstId: dst.id,
    relType,
    weight: 1,
    sourceChunk: chunkId,
    source,
  };
}

function aliasesFor(tableName: string, profile: SchemaSemanticProfile): string[] {
  return profile === "oneapi" ? (ONEAPI_ALIASES[tableName] ?? []) : [];
}

export function inferReferences(
  catalog: SchemaCatalog,
  profile: SchemaSemanticProfile = "generic",
): RelationMeta[] {
  const names = new Set(catalog.tables.map((table) => table.table.name));
  const refs = new Map<string, RelationMeta>();
  const add = (ref: RelationMeta): void => {
    if (!names.has(ref.fromTable) || !names.has(ref.toTable) || ref.fromTable === ref.toTable)
      return;
    refs.set(`${ref.fromTable}.${ref.fromColumn}->${ref.toTable}.${ref.toColumn}`, ref);
  };
  for (const table of catalog.tables) for (const relation of table.relations) add(relation);

  const pick = (name: string): string | undefined => (names.has(name) ? name : undefined);
  const resolveTarget = (column: string, fromTable: string): string | undefined => {
    if (!column.endsWith("_id")) return undefined;
    const stem = column.slice(0, -3);
    if (profile === "oneapi") {
      if (stem === "subscription") {
        if (fromTable.startsWith("claude_code_")) return pick("claude_code_subscriptions");
        if (fromTable.startsWith("packages_")) return pick("packages_subscriptions");
      }
      if (stem === "plan") {
        if (fromTable.startsWith("claude_code_")) return pick("claude_code_plans");
        if (fromTable.startsWith("packages_")) return pick("packages_plans");
      }
      if (stem === "template" || stem === "coupon") return pick("coupon_templates");
      if (stem === "gateway") return pick("payments");
    }
    const candidates = [`${stem}s`, `${stem}es`, stem];
    if (stem.endsWith("y")) candidates.push(`${stem.slice(0, -1)}ies`);
    return candidates.find((name) => names.has(name) && name !== fromTable);
  };

  for (const table of catalog.tables) {
    const fromTable = table.table.name;
    for (const column of table.columns) {
      const target = resolveTarget(column.name, fromTable);
      if (target) add({ fromTable, fromColumn: column.name, toTable: target, toColumn: "id" });
      if (profile === "oneapi" && column.name === "group" && fromTable !== "user_groups") {
        add({ fromTable, fromColumn: "group", toTable: "user_groups", toColumn: "symbol" });
      }
      if (
        profile === "oneapi" &&
        (column.name === "model" || column.name === "model_name") &&
        fromTable !== "prices"
      ) {
        add({ fromTable, fromColumn: column.name, toTable: "prices", toColumn: "model" });
      }
    }
  }
  return [...refs.values()];
}

export function exportTableGraph(graph: KnowledgeGraph): GraphExport {
  const tables = graph.listEntities({ type: "table", limit: 500 });
  const idSet = new Set(tables.map((entity) => entity.id));
  const edges = [];
  for (const table of tables) {
    for (const relation of graph.neighbors(table.id, 1).relations) {
      if (relation.relType === "has_column") continue;
      if (!idSet.has(relation.srcId) || !idSet.has(relation.dstId)) continue;
      edges.push({
        id: relation.id,
        source: relation.srcId,
        target: relation.dstId,
        relType: relation.relType,
        weight: relation.weight,
      });
    }
  }
  const seen = new Set<string>();
  const deduped = edges.filter((edge) => {
    if (seen.has(edge.id)) return false;
    seen.add(edge.id);
    return true;
  });
  return {
    nodes: tables.map((entity) => ({ id: entity.id, name: entity.name, type: entity.type })),
    edges: deduped,
    stats: { entities: tables.length, relations: deduped.length },
  };
}

export function matchTableNames(
  query: string,
  tableNames: string[],
  profile: SchemaSemanticProfile = "generic",
): string[] {
  const normalized = query.toLowerCase();
  const hits: string[] = [];
  for (const name of tableNames) {
    if (normalized.includes(name.toLowerCase())) hits.push(name);
    for (const alias of aliasesFor(name, profile)) {
      if (query.includes(alias) || normalized.includes(alias.toLowerCase())) {
        hits.push(name);
        break;
      }
    }
  }
  return [...new Set(hits)];
}

export async function exportQuerySubgraph(
  graph: KnowledgeGraph,
  query: string,
  profile: SchemaSemanticProfile = "generic",
  opts: { maxHops?: number; maxNodes?: number } = {},
): Promise<{ seeds: Entity[]; graph: GraphExport; formatted: string }> {
  const result = await graph.retrieve(query, {
    maxHops: opts.maxHops ?? 2,
    maxNodes: opts.maxNodes ?? 48,
  });
  const tables = graph.listEntities({ type: "table", limit: 500 });
  const extraSeeds = matchTableNames(
    query,
    tables.map((table) => table.name),
    profile,
  )
    .map((name) => tables.find((table) => table.name === name))
    .filter((entity): entity is Entity => Boolean(entity))
    .filter((entity) => !result.seeds.some((seed) => seed.id === entity.id));
  const seeds = [...result.seeds, ...extraSeeds];
  const subgraph = seeds.length
    ? graph.retriever.expand(
        seeds.map((seed) => seed.id),
        { maxHops: opts.maxHops ?? 2, maxNodes: opts.maxNodes ?? 48 },
      )
    : result.subgraph;
  const nodes = (subgraph?.entities ?? []).map((entity) => ({
    id: entity.id,
    name: entity.name,
    type: entity.type,
  }));
  const edges = (subgraph?.relations ?? [])
    .filter((relation) => relation.relType !== "has_column")
    .map((relation) => ({
      id: relation.id,
      source: relation.srcId,
      target: relation.dstId,
      relType: relation.relType,
      weight: relation.weight,
    }));
  return {
    seeds,
    graph: { nodes, edges, stats: { entities: nodes.length, relations: edges.length } },
    formatted: subgraph?.formatted() ?? "",
  };
}
