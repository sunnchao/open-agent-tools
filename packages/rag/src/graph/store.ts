import { DatabaseSync } from "node:sqlite";
import type {
  DuplicateResolution,
  Entity,
  GraphQuality,
  GraphSourceState,
  GraphStore,
  Relation,
  RelationOrigin,
  Subgraph,
} from "./types.js";
import { makeSubgraph, normalizeName, relationId } from "./utils.js";

export interface SqliteGraphStoreOptions {
  /** SQLite 数据库文件路径，如 "./rag-graph.db"。 */
  dbPath: string;
  /**
   * 实体名内存索引上限。名称包含匹配（`LIKE '%x%'`）无法走索引，是检索热路径的
   * 全表扫描；把名称载入内存做子串匹配可把每次候选词查询从一次扫描降到一次哈希遍历。
   * 实体数超过该阈值时不建索引，退回 SQL LIKE，避免超大图上吃满内存。
   */
  nameIndexLimit?: number;
}

interface EntityRow {
  id: string;
  name: string;
  type: string;
  props: string;
}

interface RelationRow {
  id: string;
  src_id: string;
  dst_id: string;
  rel_type: string;
  weight: number;
  source_chunk: string;
  source: string;
  origin: string;
}

interface SourceRow {
  source: string;
  status: string;
  entities: number;
  relations: number;
  chunks: number;
  updated_at: string;
  error: string | null;
}

const SOURCE_STATUSES = new Set(["pending", "building", "ready", "failed"]);
const RELATION_ORIGINS = new Set<RelationOrigin>(["llm", "rule", "schema"]);

/**
 * v1 存量数据的占位来源。这些实体/关系产生于「关系不记录文档来源」的旧版本，
 * 无法从 chunk id 反推归属，先挂占位来源避免被级联删除误伤，由 reconcile 清理。
 */
export const LEGACY_SOURCE = "__legacy__";

function toSourceState(r: SourceRow): GraphSourceState {
  const status = SOURCE_STATUSES.has(r.status)
    ? (r.status as GraphSourceState["status"])
    : "pending";
  const state: GraphSourceState = {
    source: r.source,
    status,
    entities: Number(r.entities),
    relations: Number(r.relations),
    chunks: Number(r.chunks),
    updatedAt: r.updated_at,
  };
  if (r.error) state.error = r.error;
  return state;
}

function toEntity(r: EntityRow): Entity {
  let props: Record<string, string> = {};
  try {
    props = JSON.parse(r.props) as Record<string, string>;
  } catch {
    props = {};
  }
  return { id: r.id, name: r.name, type: r.type, props };
}

function toRelation(r: RelationRow): Relation {
  const origin = RELATION_ORIGINS.has(r.origin as RelationOrigin)
    ? (r.origin as RelationOrigin)
    : undefined;
  const relation: Relation = {
    id: r.id,
    srcId: r.src_id,
    dstId: r.dst_id,
    relType: r.rel_type,
    weight: r.weight,
    sourceChunk: r.source_chunk,
    source: r.source ?? "",
  };
  if (origin) relation.origin = origin;
  return relation;
}

/**
 * SQLite 邻接表存储实现：
 * - `entities` 表存实体（name 规范化后入库，同实体 upsert 合并）；
 * - `relations` 表存有向边（weight 累加同源频次），src/dst/type 建索引；
 * - 邻域查询为 BFS 多跳 join，百万节点内毫秒级可接受。
 */
export class SqliteGraphStore implements GraphStore {
  private db: DatabaseSync;
  private nameIndexLimit: number;
  /**
   * 名称索引：规范化名 → 实体。`null` 表示尚未构建，`false` 表示超出规模上限不建。
   * 任何写操作都会把它失效，下次查询时重建。
   */
  private nameIndex: Entity[] | false | null = null;
  private vectorRevision = 0;

  constructor(opts: SqliteGraphStoreOptions) {
    this.db = new DatabaseSync(opts.dbPath);
    this.nameIndexLimit = opts.nameIndexLimit ?? 50_000;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        type       TEXT NOT NULL,
        props      TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
      CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);

      CREATE TABLE IF NOT EXISTS relations (
        id           TEXT PRIMARY KEY,
        src_id       TEXT NOT NULL REFERENCES entities(id),
        dst_id       TEXT NOT NULL REFERENCES entities(id),
        rel_type     TEXT NOT NULL,
        weight       INTEGER NOT NULL DEFAULT 1,
        source_chunk TEXT NOT NULL,
        source       TEXT NOT NULL DEFAULT '',
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_relations_src ON relations(src_id);
      CREATE INDEX IF NOT EXISTS idx_relations_dst ON relations(dst_id);
      CREATE INDEX IF NOT EXISTS idx_relations_type ON relations(rel_type);
      -- idx_relations_source 依赖 source 列，旧库建表时该列尚不存在，
      -- 故延后到 migrate() 在 ALTER 补列之后统一建（见 migrate 内）。

      CREATE TABLE IF NOT EXISTS entity_aliases (
        entity_id  TEXT NOT NULL REFERENCES entities(id),
        alias      TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (entity_id, alias)
      );
      CREATE INDEX IF NOT EXISTS idx_aliases_alias ON entity_aliases(alias);

      CREATE TABLE IF NOT EXISTS entity_sources (
        entity_id  TEXT NOT NULL REFERENCES entities(id),
        source     TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (entity_id, source)
      );
      CREATE INDEX IF NOT EXISTS idx_entity_sources_source ON entity_sources(source);

      CREATE TABLE IF NOT EXISTS relation_sources (
        relation_id TEXT NOT NULL REFERENCES relations(id),
        source      TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (relation_id, source)
      );
      CREATE INDEX IF NOT EXISTS idx_relation_sources_source ON relation_sources(source);

      CREATE TABLE IF NOT EXISTS graph_sources (
        source     TEXT PRIMARY KEY,
        status     TEXT NOT NULL DEFAULT 'pending',
        entities   INTEGER NOT NULL DEFAULT 0,
        relations  INTEGER NOT NULL DEFAULT 0,
        chunks     INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        error      TEXT
      );

      -- 实体名向量：入库时预计算，检索期直接读，避免每次查询都对上百个实体名
      -- 调一次 embedding 接口（旧实现只在「名字最短的 100 个实体」上兜底，覆盖面极小）。
      CREATE TABLE IF NOT EXISTS entity_embeddings (
        entity_id TEXT PRIMARY KEY REFERENCES entities(id),
        vector    TEXT NOT NULL
      );
    `);
    this.migrate();
  }

  /**
   * 旧库迁移：
   * 1. v1 的 relations 表无 source 列（当时只有 source_chunk 存 chunk id，
   *    导致按文件名删除恒不命中，removeBySource 实为空操作）——补列；
   * 2. relations 无 origin 列——补列，存量数据按 llm 处理（保持旧排序行为）；
   * 3. 存量实体/关系没有来源归属，直接进入新的级联删除逻辑会被判为"无依据"而误删。
   *    统一挂到 LEGACY_SOURCE 占位来源下，等 reconcile 按真实来源重建后自然消解。
   */
  private migrate(): void {
    const relationColumns = this.db
      .prepare(`PRAGMA table_info(relations)`)
      .all() as unknown as Array<{
      name: string;
    }>;
    // 只有真正缺少 v1 列的老库才需要「收养遗留数据」；新库/已迁移库一律跳过。
    const needsLegacyAdoption =
      !relationColumns.some((c) => c.name === "source") ||
      !relationColumns.some((c) => c.name === "origin");
    if (!relationColumns.some((c) => c.name === "source")) {
      this.db.exec(`ALTER TABLE relations ADD COLUMN source TEXT NOT NULL DEFAULT ''`);
    }
    if (!relationColumns.some((c) => c.name === "origin")) {
      this.db.exec(`ALTER TABLE relations ADD COLUMN origin TEXT NOT NULL DEFAULT 'llm'`);
    }
    // 新库在 exec 建表时已具备 source 列；旧库在 ALTER 之后才具备。
    // 无论哪种，都在此统一补建索引，避免初始 exec 在旧库上因缺列而失败。
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source)`);

    // v1 遗留数据收养：只在本次确实做了 v1 结构迁移时执行一次。
    //
    // 早先这里无条件执行，后果是每次打开库都把「当前没有来源归属」的实体
    // 全挂到 __legacy__ 名下——而合法操作也会产生无归属实体：
    // removeBySource 解绑某来源后，实体若仍被其他边连接就不会被删除，于是变成
    // 「无来源归属」。下次启动就会被当成遗留数据收养，造成来源污染
    // （实测 329 个实体被错误挂到 __legacy__）。
    if (needsLegacyAdoption) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO relation_sources (relation_id, source)
           SELECT id, CASE WHEN source = '' THEN ? ELSE source END FROM relations
           WHERE id NOT IN (SELECT relation_id FROM relation_sources)`,
        )
        .run(LEGACY_SOURCE);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO entity_sources (entity_id, source)
           SELECT id, ? FROM entities WHERE id NOT IN (SELECT entity_id FROM entity_sources)`,
        )
        .run(LEGACY_SOURCE);
    }

    // 占位来源登记进状态表，才能在对账中以 orphan 形式暴露并被 reconcile 清理
    const legacy = this.countBySource(LEGACY_SOURCE);
    if (legacy.entities > 0 || legacy.relations > 0) {
      this.markSource(LEGACY_SOURCE, {
        status: "ready",
        entities: legacy.entities,
        relations: legacy.relations,
      });
    } else {
      this.removeSourceRecord(LEGACY_SOURCE);
    }
  }

  /** 写操作后失效名称索引，保证下次查询重建。 */
  private invalidateNameIndex(): void {
    this.nameIndex = null;
    this.vectorRevision += 1;
  }

  entityVectorRevision(): number {
    return this.vectorRevision;
  }

  private entities(): Entity[] | null {
    if (this.nameIndex === false) return null;
    if (this.nameIndex === null) {
      const total = this.stats().entities;
      if (total > this.nameIndexLimit) {
        this.nameIndex = false;
        return null;
      }
      const rows = this.db.prepare(`SELECT * FROM entities`).all() as unknown as EntityRow[];
      this.nameIndex = rows.map(toEntity);
    }
    return this.nameIndex;
  }

  upsertEntity(e: Entity): void {
    this.db
      .prepare(
        `INSERT INTO entities (id, name, type, props) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, type = excluded.type, props = excluded.props`,
      )
      .run(e.id, e.name, e.type, JSON.stringify(e.props));
    this.invalidateNameIndex();
  }

  upsertRelation(r: Relation): void {
    this.db
      .prepare(
        `INSERT INTO relations (id, src_id, dst_id, rel_type, weight, source_chunk, source, origin)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET weight = relations.weight + 1,
           source_chunk = excluded.source_chunk,
           source = excluded.source,
           origin = excluded.origin`,
      )
      .run(r.id, r.srcId, r.dstId, r.relType, r.sourceChunk, r.source ?? "", r.origin ?? "llm");
    // 同一条边可能由多篇文档共同佐证，来源关系单独建表，删一篇不牵连其余。
    // 不变量：每条边必有至少一条归属记录——否则会被下一次任意来源的级联删除顺带清掉。
    this.db
      .prepare(`INSERT OR IGNORE INTO relation_sources (relation_id, source) VALUES (?, ?)`)
      .run(r.id, r.source || LEGACY_SOURCE);
  }

  linkEntitySource(entityId: string, source: string): void {
    if (!source) return;
    this.db
      .prepare(`INSERT OR IGNORE INTO entity_sources (entity_id, source) VALUES (?, ?)`)
      .run(entityId, source);
  }

  findEntityById(id: string): Entity | null {
    const row = this.db.prepare(`SELECT * FROM entities WHERE id = ?`).get(id) as
      EntityRow | undefined;
    return row ? toEntity(row) : null;
  }

  /** 批量取实体，避免 BFS 展开时逐条 SELECT。 */
  findEntitiesByIds(ids: readonly string[]): Entity[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT * FROM entities WHERE id IN (${placeholders})`)
      .all(...ids) as unknown as EntityRow[];
    const byId = new Map(rows.map((row) => [row.id, toEntity(row)] as const));
    // 保持调用方给定的顺序，结果里跳过不存在的 id
    return ids.map((id) => byId.get(id)).filter((e): e is Entity => e !== undefined);
  }

  findEntitiesByName(name: string, limit = 10): Entity[] {
    const normalized = normalizeName(name);
    if (!normalized) return [];
    const indexed = this.entities();
    if (indexed) {
      // 精确优先（与 SQL `name = ?` 一致，大小写敏感）
      const exact = indexed.filter((e) => e.name === normalized);
      if (exact.length > 0) {
        return exact.sort((a, b) => a.name.length - b.name.length).slice(0, limit);
      }
      // 包含匹配：SQL `LIKE '%x%'` 对 ASCII 大小写不敏感，内存索引必须保持同一语义，
      // 否则手工写入未规范化的名称（如 "OpenAI"）在换用索引后会查不到。
      return indexed
        .filter((e) => e.name.toLowerCase().includes(normalized))
        .sort((a, b) => a.name.length - b.name.length)
        .slice(0, limit);
    }
    // 超大图回退 SQL（避免把全部实体载入内存）
    const exact = this.db
      .prepare(`SELECT * FROM entities WHERE name = ? ORDER BY length(name) LIMIT ?`)
      .all(normalized, limit) as unknown as EntityRow[];
    if (exact.length > 0) return exact.map(toEntity);
    const contains = this.db
      .prepare(`SELECT * FROM entities WHERE name LIKE ? ORDER BY length(name) LIMIT ?`)
      .all(`%${normalized}%`, limit) as unknown as EntityRow[];
    return contains.map(toEntity);
  }

  /**
   * 限定来源的名称匹配。
   *
   * 图谱实体可能由多篇文档共同支撑；只要命中来源集合中的任意一篇即可返回。
   * 空来源集合显式返回空，不能退化成“不过滤”。
   */
  findEntitiesByNameInSources(name: string, sources: readonly string[], limit = 10): Entity[] {
    const normalized = normalizeName(name);
    if (!normalized || sources.length === 0) return [];
    const placeholders = sources.map(() => "?").join(", ");
    const scope = `e.id IN (SELECT es.entity_id FROM entity_sources es WHERE es.source IN (${placeholders}))`;
    const exact = this.db
      .prepare(
        `SELECT e.* FROM entities e
         WHERE e.name = ? AND ${scope}
         ORDER BY length(e.name) LIMIT ?`,
      )
      .all(normalized, ...sources.map((source) => source), limit) as unknown as EntityRow[];
    if (exact.length > 0) return exact.map(toEntity);
    const contains = this.db
      .prepare(
        `SELECT e.* FROM entities e
         WHERE e.name LIKE ? AND ${scope}
         ORDER BY length(e.name) LIMIT ?`,
      )
      .all(`%${normalized}%`, ...sources.map((source) => source), limit) as unknown as EntityRow[];
    return contains.map(toEntity);
  }

  graphForSource(source: string): Subgraph {
    const entities = this.db
      .prepare(
        `SELECT e.* FROM entities e
         JOIN entity_sources es ON es.entity_id = e.id
         WHERE es.source = ? ORDER BY length(e.name), e.name, e.id`,
      )
      .all(source) as unknown as EntityRow[];
    const relations = this.db
      .prepare(
        `SELECT r.* FROM relations r
         JOIN relation_sources rs ON rs.relation_id = r.id
         JOIN entity_sources src ON src.entity_id = r.src_id AND src.source = rs.source
         JOIN entity_sources dst ON dst.entity_id = r.dst_id AND dst.source = rs.source
         WHERE rs.source = ? ORDER BY r.id`,
      )
      .all(source) as unknown as RelationRow[];
    return makeSubgraph(entities.map(toEntity), relations.map(toRelation));
  }

  /** 单起点邻域展开；内部复用批量实现，避免两套 BFS 逻辑漂移。 */
  neighbors(
    entityId: string,
    hops: number,
    opts: { maxNodes?: number; minWeight?: number; sources?: readonly string[] } = {},
  ): Subgraph {
    return this.neighborsBatch([entityId], hops, opts);
  }

  /**
   * 批量多跳邻域扩展：每层用一条 `IN (...)` 查询取回整层边，替代逐节点查询。
   *
   * 旧实现每个节点一次 SQL、每个邻居再一次实体查询、每条边再一次重查，
   * maxNodes=64 时最坏几百次往返。这里按层批处理，查询次数约为 O(hops)。
   */
  neighborsBatch(
    entityIds: readonly string[],
    hops: number,
    opts: { maxNodes?: number; minWeight?: number; sources?: readonly string[] } = {},
  ): Subgraph {
    const maxNodes = opts.maxNodes ?? 64;
    const minWeight = opts.minWeight ?? 1;
    const sources = opts.sources;
    if (optionsEmpty(sources) || entityIds.length === 0) return makeSubgraph([], []);
    const sourceList = sources ?? [];
    const scoped = sourceList.length > 0;

    // 起点先做来源校验：不在白名单内的种子不参与扩展
    const seeds = scoped
      ? this.findEntitiesByIds(entityIds).filter((entity) =>
          this.entitySources(entity.id).some((source) => sourceList.includes(source)),
        )
      : this.findEntitiesByIds(entityIds);
    if (seeds.length === 0) return makeSubgraph([], []);

    const seen = new Map<string, Entity>();
    for (const seed of seeds) {
      if (seen.size >= maxNodes) break;
      seen.set(seed.id, seed);
    }
    const relationIds = new Set<string>();
    const relationRows: Relation[] = [];
    const remember = (rows: RelationRow[]): void => {
      for (const row of rows) {
        if (relationIds.has(row.id)) continue;
        relationIds.add(row.id);
        relationRows.push(toRelation(row));
      }
    };

    const inList = (size: number): string => Array.from({ length: size }, () => "?").join(", ");
    const sourceFilter = scoped
      ? ` AND src_id IN (SELECT entity_id FROM entity_sources WHERE source IN (${inList(sourceList.length)}))
          AND dst_id IN (SELECT entity_id FROM entity_sources WHERE source IN (${inList(sourceList.length)}))`
      : "";
    const relationScope = scoped
      ? ` AND id IN (SELECT relation_id FROM relation_sources WHERE source IN (${inList(sourceList.length)}))`
      : "";

    let frontier = seeds.map((seed) => seed.id);
    for (let hop = 0; hop < hops && frontier.length > 0; hop += 1) {
      const placeholders = inList(frontier.length);
      // 参数顺序必须与 SQL 占位符出现顺序一致：
      // src_id IN (...) → dst_id IN (...) → weight >= ? → src 来源 → dst 来源 → 边来源
      const params: Array<string | number> = [...frontier, ...frontier, minWeight];
      if (scoped) params.push(...sourceList, ...sourceList, ...sourceList);
      const rows = this.db
        .prepare(
          `SELECT * FROM relations
           WHERE (src_id IN (${placeholders}) OR dst_id IN (${placeholders}))
             AND weight >= ?${sourceFilter}${relationScope}
           ORDER BY weight DESC`,
        )
        .all(...params) as unknown as RelationRow[];
      remember(rows);

      // 用 Set 记录本层起点：frontier.includes 在每层内是 O(n²)
      const frontierSet = new Set(frontier);
      const next: string[] = [];
      for (const row of rows) {
        for (const other of [row.src_id, row.dst_id]) {
          if (frontierSet.has(other) || seen.has(other) || seen.size >= maxNodes) continue;
          next.push(other);
        }
      }
      if (next.length === 0) break;
      for (const entity of this.findEntitiesByIds(next)) {
        if (seen.has(entity.id)) continue;
        if (seen.size < maxNodes) seen.set(entity.id, entity);
      }
      frontier = next.filter((id) => seen.has(id));
    }

    // 只保留两端都在子图内的关系：否则序列化会退化成裸 40 位实体 id
    const relations = relationRows.filter(
      (relation) => seen.has(relation.srcId) && seen.has(relation.dstId),
    );
    return makeSubgraph([...seen.values()], relations);
  }

  /**
   * 级联删除某来源的图谱数据。四步，顺序不可换：
   * 1. 解绑该来源的边归属，删除已无任何来源支撑的边；
   * 2. 解绑该来源的实体归属；
   * 3. 删除既无来源归属、又无边连接的实体（被其他文档共享的实体在此保留）；
   * 4. 清理这些实体的别名。
   */
  /**
   * 仅当某条关系已无任何来源支撑时删除它。
   *
   * 用于「重建成功后清理陈旧数据」：必须确认没有其他文档还在佐证这条边，
   * 否则会把别的来源的数据一起删掉。
   */
  removeRelationIfUnreferenced(relationId: string, source: string): boolean {
    const rows = this.db
      .prepare(`SELECT source FROM relation_sources WHERE relation_id = ?`)
      .all(relationId) as unknown as Array<{ source: string }>;
    if (rows.length === 0) return false;
    const others = rows.filter((row) => row.source !== source);
    if (others.length > 0) {
      // 还有其他来源佐证：只解绑本次来源
      this.db
        .prepare(`DELETE FROM relation_sources WHERE relation_id = ? AND source = ?`)
        .run(relationId, source);
      return false;
    }
    this.db.prepare(`DELETE FROM relation_sources WHERE relation_id = ?`).run(relationId);
    this.db.prepare(`DELETE FROM relations WHERE id = ?`).run(relationId);
    return true;
  }

  /** 仅当某实体已无来源归属且无边连接时删除它（重建后的陈旧数据清理）。 */
  removeEntityIfUnreferenced(entityId: string, source: string): boolean {
    const rows = this.db
      .prepare(`SELECT source FROM entity_sources WHERE entity_id = ?`)
      .all(entityId) as unknown as Array<{ source: string }>;
    if (rows.length === 0) return false;
    const others = rows.filter((row) => row.source !== source);
    if (others.length > 0) {
      this.db
        .prepare(`DELETE FROM entity_sources WHERE entity_id = ? AND source = ?`)
        .run(entityId, source);
      return false;
    }
    this.db.prepare(`DELETE FROM entity_sources WHERE entity_id = ?`).run(entityId);
    const connected = this.db
      .prepare(`SELECT COUNT(*) AS n FROM relations WHERE src_id = ? OR dst_id = ?`)
      .get(entityId, entityId) as { n: number };
    if (Number(connected.n) > 0) return false;
    this.db.prepare(`DELETE FROM entity_aliases WHERE entity_id = ?`).run(entityId);
    this.db.prepare(`DELETE FROM entity_embeddings WHERE entity_id = ?`).run(entityId);
    this.db.prepare(`DELETE FROM entities WHERE id = ?`).run(entityId);
    this.invalidateNameIndex();
    return true;
  }

  /**
   * 级联删除某来源的图谱数据。四步，顺序不可换：
   * 1. 解绑该来源的边归属，删除已无任何来源支撑的边；
   * 2. 解绑该来源的实体归属；
   * 3. 删除既无来源归属、又无边连接的实体（被其他文档共享的实体在此保留）；
   * 4. 清理这些实体的别名。
   */
  removeBySource(source: string): { relations: number; entities: number } {
    const before = this.stats();

    this.db.prepare(`DELETE FROM relation_sources WHERE source = ?`).run(source);
    // 迁移阶段已为全部存量边补齐来源归属，故此处可安全地按"无来源支撑"判定删除，
    // 不依赖 relations.source 单值列（该列在多源边上只记最后写入者，按它删会漏）
    this.db
      .prepare(`DELETE FROM relations WHERE id NOT IN (SELECT relation_id FROM relation_sources)`)
      .run();

    this.db.prepare(`DELETE FROM entity_sources WHERE source = ?`).run(source);

    // 无来源归属 + 无边连接 = 该实体已无任何存在依据
    this.db
      .prepare(
        `DELETE FROM entity_aliases WHERE entity_id IN (
           SELECT id FROM entities
           WHERE id NOT IN (SELECT entity_id FROM entity_sources)
             AND id NOT IN (SELECT src_id FROM relations UNION SELECT dst_id FROM relations)
         )`,
      )
      .run();
    this.db
      .prepare(
        `DELETE FROM entity_embeddings WHERE entity_id IN (
           SELECT id FROM entities
           WHERE id NOT IN (SELECT entity_id FROM entity_sources)
             AND id NOT IN (SELECT src_id FROM relations UNION SELECT dst_id FROM relations)
         )`,
      )
      .run();
    this.db
      .prepare(
        `DELETE FROM entities
         WHERE id NOT IN (SELECT entity_id FROM entity_sources)
           AND id NOT IN (SELECT src_id FROM relations UNION SELECT dst_id FROM relations)`,
      )
      .run();

    this.invalidateNameIndex();
    const after = this.stats();
    return {
      relations: before.relations - after.relations,
      entities: before.entities - after.entities,
    };
  }

  countBySource(source: string): { entities: number; relations: number } {
    const e = this.db
      .prepare(`SELECT COUNT(*) AS n FROM entity_sources WHERE source = ?`)
      .get(source) as { n: number };
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM relation_sources WHERE source = ?`)
      .get(source) as { n: number };
    return { entities: Number(e.n), relations: Number(r.n) };
  }

  listSources(): GraphSourceState[] {
    const rows = this.db
      .prepare(`SELECT * FROM graph_sources ORDER BY source`)
      .all() as unknown as SourceRow[];
    return rows.map(toSourceState);
  }

  getSource(source: string): GraphSourceState | null {
    const row = this.db.prepare(`SELECT * FROM graph_sources WHERE source = ?`).get(source) as
      SourceRow | undefined;
    return row ? toSourceState(row) : null;
  }

  markSource(
    source: string,
    patch: Partial<Omit<GraphSourceState, "source" | "updatedAt">>,
  ): GraphSourceState {
    const current = this.getSource(source);
    const next = {
      status: patch.status ?? current?.status ?? "pending",
      entities: patch.entities ?? current?.entities ?? 0,
      relations: patch.relations ?? current?.relations ?? 0,
      chunks: patch.chunks ?? current?.chunks ?? 0,
      // 显式传 undefined 不清错误，需传空串；status 转为非 failed 时自动清
      error:
        patch.error !== undefined
          ? patch.error
          : patch.status && patch.status !== "failed"
            ? null
            : (current?.error ?? null),
    };
    this.db
      .prepare(
        `INSERT INTO graph_sources (source, status, entities, relations, chunks, updated_at, error)
         VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
         ON CONFLICT(source) DO UPDATE SET status = excluded.status, entities = excluded.entities,
           relations = excluded.relations, chunks = excluded.chunks,
           updated_at = excluded.updated_at, error = excluded.error`,
      )
      .run(source, next.status, next.entities, next.relations, next.chunks, next.error || null);
    return this.getSource(source)!;
  }

  removeSourceRecord(source: string): void {
    this.db.prepare(`DELETE FROM graph_sources WHERE source = ?`).run(source);
  }

  /**
   * 把卡在 building 的来源降级为 pending。
   *
   * 抽取中途进程被杀（重启、OOM、Ctrl-C）时状态永远停在 building：
   * 它既不属于 missing 也不属于 stale，reconcile 永远不会重试，图就永久缺失。
   * 启动时按「updated_at 早于阈值」判定为僵死并复位，让对账能重新建图。
   */
  resetStuckSources(updatedBefore: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT source FROM graph_sources WHERE status = 'building' AND updated_at < ? ORDER BY source`,
      )
      .all(updatedBefore) as unknown as Array<{ source: string }>;
    if (rows.length === 0) return [];
    this.db
      .prepare(
        `UPDATE graph_sources SET status = 'pending', error = ? WHERE status = 'building' AND updated_at < ?`,
      )
      .run("reset: 上次抽取未正常结束", updatedBefore);
    return rows.map((row) => row.source);
  }

  listEntities(
    opts: { offset?: number; limit?: number; type?: string; search?: string } = {},
  ): Entity[] {
    const { offset = 0, limit = 50, type, search } = opts;
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (type) {
      where.push("type = ?");
      params.push(type);
    }
    if (search) {
      where.push("(name LIKE ? OR type LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like);
    }
    const sql = `SELECT * FROM entities${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY length(name) LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    const rows = this.db.prepare(sql).all(...params) as unknown as EntityRow[];
    return rows.map(toEntity);
  }

  stats(): { entities: number; relations: number } {
    const e = this.db.prepare(`SELECT COUNT(*) AS n FROM entities`).get() as { n: number };
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM relations`).get() as { n: number };
    return { entities: Number(e.n), relations: Number(r.n) };
  }

  countRelationsByType(): { relType: string; count: number }[] {
    const rows = this.db
      .prepare(`SELECT rel_type, COUNT(*) AS n FROM relations GROUP BY rel_type ORDER BY n DESC`)
      .all() as unknown as Array<{ rel_type: string; n: number }>;
    return rows.map((r) => ({ relType: r.rel_type, count: Number(r.n) }));
  }

  /** 图谱质量快照：一次聚合把「图有没有被建坏」的关键指标算出来。 */
  quality(): GraphQuality {
    const { entities, relations } = this.stats();
    const degreeRows = this.db
      .prepare(
        `SELECT id, (
           SELECT COUNT(*) FROM relations r WHERE r.src_id = e.id OR r.dst_id = e.id
         ) AS deg FROM entities e`,
      )
      .all() as unknown as Array<{ id: string; deg: number }>;
    let isolated = 0;
    let leaf = 0;
    let degreeSum = 0;
    for (const row of degreeRows) {
      const deg = Number(row.deg);
      degreeSum += deg;
      if (deg === 0) isolated += 1;
      if (deg <= 1) leaf += 1;
    }
    // 共现边占比：related_to 谓词与 rule 通道是同一批边的两个维度，不能相加，
    // 否则一条 related_to+rule 边会被算两次，占比能超过 1。用 OR 归并成单一条件。
    const relatedTo = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM relations WHERE rel_type = 'related_to' OR origin = 'rule'`,
      )
      .get() as { n: number };
    const relatedToCount = Number(relatedTo.n);
    const weightOne = this.db
      .prepare(`SELECT COUNT(*) AS n FROM relations WHERE weight = 1`)
      .get() as { n: number };
    const dup = this.db
      .prepare(
        `SELECT COUNT(*) AS groups, COALESCE(SUM(c - 1), 0) AS extra
         FROM (SELECT name, COUNT(*) AS c FROM entities GROUP BY name HAVING c > 1)`,
      )
      .get() as { groups: number; extra: number };
    const reverse = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM relations a
         JOIN relations b
           ON a.src_id = b.dst_id AND a.dst_id = b.src_id AND a.rel_type = b.rel_type
         WHERE a.id < b.id`,
      )
      .get() as { n: number };
    const loops = this.db
      .prepare(`SELECT COUNT(*) AS n FROM relations WHERE src_id = dst_id`)
      .get() as { n: number };

    return {
      entities,
      relations,
      isolatedEntities: isolated,
      leafEntities: leaf,
      relatedToRatio: relations > 0 ? relatedToCount / relations : 0,
      weightOneRatio: relations > 0 ? Number(weightOne.n) / relations : 0,
      avgDegree: entities > 0 ? degreeSum / entities : 0,
      duplicateNameGroups: Number(dup.groups),
      redundantEntities: Number(dup.extra),
      reverseDuplicateRelations: Number(reverse.n),
      selfLoops: Number(loops.n),
      relationsByType: this.countRelationsByType(),
    };
  }

  /**
   * 合并同名多 type 实体。
   *
   * 实体 id 里带 type（`sha1(name:type)`），LLM 对同一名称给出不同 type 时就会分裂成
   * 多个节点，各自挂一半的边，子图扩展永远走不到另一半。这里把重复节点的边与来源
   * 归属重定向到主实体后删除它们；重定向后自环或重复的边被丢弃。
   */
  mergeEntities(
    primaryId: string,
    duplicateIds: readonly string[],
  ): Omit<DuplicateResolution, "groups"> {
    const primary = this.findEntityById(primaryId);
    const duplicates = duplicateIds.filter((id) => id !== primaryId);
    if (!primary || duplicates.length === 0) {
      return { movedRelations: 0, droppedRelations: 0, removedEntities: 0 };
    }
    let movedRelations = 0;
    let droppedRelations = 0;

    for (const dupId of duplicates) {
      const dup = this.findEntityById(dupId);
      if (!dup) continue;
      const touching = this.db
        .prepare(`SELECT * FROM relations WHERE src_id = ? OR dst_id = ?`)
        .all(dupId, dupId) as unknown as RelationRow[];
      const dupSources = (
        this.db
          .prepare(`SELECT source FROM entity_sources WHERE entity_id = ?`)
          .all(dupId) as unknown as Array<{ source: string }>
      ).map((row) => row.source);
      const dupAliases = this.aliasesOf(dupId);

      // 先解绑并删除旧边，再用主实体重算 id 重新 upsert，让冲突边自动累加 weight。
      // relation_sources 必须先于 relations 清理：它是外键引用方，留着会触发
      // FOREIGN KEY constraint failed（node:sqlite 默认开启外键约束）。
      this.db
        .prepare(
          `DELETE FROM relation_sources WHERE relation_id IN
             (SELECT id FROM relations WHERE src_id = ? OR dst_id = ?)`,
        )
        .run(dupId, dupId);
      this.db.prepare(`DELETE FROM relations WHERE src_id = ? OR dst_id = ?`).run(dupId, dupId);
      for (const row of touching) {
        const relation = toRelation(row);
        const srcId = relation.srcId === dupId ? primaryId : relation.srcId;
        const dstId = relation.dstId === dupId ? primaryId : relation.dstId;
        if (srcId === dstId) {
          droppedRelations += 1;
          continue;
        }
        this.upsertRelation({
          ...relation,
          id: relationId(srcId, relation.relType, dstId),
          srcId,
          dstId,
        });
        movedRelations += 1;
      }

      // 归属与别名平移到主实体；主实体自身名再登记一次别名，便于按旧名检索
      for (const source of dupSources) this.linkEntitySource(primaryId, source);
      for (const alias of dupAliases) this.addAlias(primaryId, alias);
      this.addAlias(primaryId, dup.name);
      this.db.prepare(`DELETE FROM entity_aliases WHERE entity_id = ?`).run(dupId);
      this.db.prepare(`DELETE FROM entity_sources WHERE entity_id = ?`).run(dupId);
      this.db.prepare(`DELETE FROM entity_embeddings WHERE entity_id = ?`).run(dupId);
      this.db.prepare(`DELETE FROM entities WHERE id = ?`).run(dupId);
    }

    this.invalidateNameIndex();
    return { movedRelations, droppedRelations, removedEntities: duplicates.length };
  }

  addAlias(entityId: string, alias: string): void {
    const normalized = normalizeName(alias);
    if (!normalized) return;
    this.db
      .prepare(`INSERT OR IGNORE INTO entity_aliases (entity_id, alias) VALUES (?, ?)`)
      .run(entityId, normalized);
  }

  findByAlias(alias: string): Entity | null {
    const normalized = normalizeName(alias);
    if (!normalized) return null;
    const row = this.db
      .prepare(
        `SELECT e.* FROM entity_aliases a JOIN entities e ON e.id = a.entity_id WHERE a.alias = ? LIMIT 1`,
      )
      .get(normalized) as EntityRow | undefined;
    return row ? toEntity(row) : null;
  }

  /** 限定来源的别名定位，避免通过别名绕过 sources 白名单。 */
  findByAliasInSources(alias: string, sources: readonly string[]): Entity | null {
    const normalized = normalizeName(alias);
    if (!normalized || sources.length === 0) return null;
    const placeholders = sources.map(() => "?").join(", ");
    const row = this.db
      .prepare(
        `SELECT e.* FROM entity_aliases a
         JOIN entities e ON e.id = a.entity_id
         WHERE a.alias = ?
           AND e.id IN (
             SELECT es.entity_id FROM entity_sources es WHERE es.source IN (${placeholders})
           )
         LIMIT 1`,
      )
      .get(normalized, ...sources.map((source) => source)) as EntityRow | undefined;
    return row ? toEntity(row) : null;
  }

  entitySources(entityId: string): string[] {
    const rows = this.db
      .prepare(`SELECT source FROM entity_sources WHERE entity_id = ? ORDER BY source`)
      .all(entityId) as unknown as Array<{ source: string }>;
    return rows.map((row) => row.source);
  }

  entityIdsInSources(sources: readonly string[]): string[] {
    const ids = new Set<string>();
    // 分批绑定，避免较大的来源白名单超过 SQLite 参数上限。
    for (let offset = 0; offset < sources.length; offset += 500) {
      const batch = sources.slice(offset, offset + 500);
      const placeholders = batch.map(() => "?").join(", ");
      const rows = this.db
        .prepare(`SELECT DISTINCT entity_id FROM entity_sources WHERE source IN (${placeholders})`)
        .all(...batch) as unknown as Array<{ entity_id: string }>;
      for (const row of rows) ids.add(row.entity_id);
    }
    return [...ids];
  }

  aliasesOf(entityId: string): string[] {
    const rows = this.db
      .prepare(`SELECT alias FROM entity_aliases WHERE entity_id = ? ORDER BY created_at`)
      .all(entityId) as unknown as Array<{ alias: string }>;
    return rows.map((r) => r.alias);
  }

  /** 写入实体名向量（入库时预计算；已存在则覆盖）。 */
  upsertEntityEmbeddings(entries: ReadonlyArray<{ id: string; vector: readonly number[] }>): void {
    if (entries.length === 0) return;
    this.vectorRevision += 1;
    const statement = this.db.prepare(
      `INSERT INTO entity_embeddings (entity_id, vector) VALUES (?, ?)
       ON CONFLICT(entity_id) DO UPDATE SET vector = excluded.vector`,
    );
    for (const entry of entries) {
      statement.run(entry.id, JSON.stringify(entry.vector));
    }
  }

  /** 读取全部实体名向量。 */
  listEntityEmbeddings(): Array<{ id: string; vector: number[] }> {
    const rows = this.db
      .prepare(`SELECT entity_id, vector FROM entity_embeddings`)
      .all() as unknown as Array<{ entity_id: string; vector: string }>;
    const out: Array<{ id: string; vector: number[] }> = [];
    for (const row of rows) {
      try {
        const vector = JSON.parse(row.vector) as unknown;
        if (Array.isArray(vector) && vector.every((v) => typeof v === "number")) {
          out.push({ id: row.entity_id, vector: vector as number[] });
        }
      } catch {
        // 损坏的行直接跳过，下次入库会重写
      }
    }
    return out;
  }

  close(): void {
    this.db.close();
  }
}

/** sources 显式传空数组表示「不检索任何来源」，需短路。 */
function optionsEmpty(sources: readonly string[] | undefined): boolean {
  return sources !== undefined && sources.length === 0;
}
