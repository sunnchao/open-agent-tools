import { DatabaseSync } from "node:sqlite";
import type { Entity, GraphSourceState, GraphStore, Relation, Subgraph } from "./types.js";
import { makeSubgraph, normalizeName } from "./utils.js";

export interface SqliteGraphStoreOptions {
  /** SQLite 数据库文件路径，如 "./rag-graph.db"。 */
  dbPath: string;
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
  return {
    id: r.id,
    srcId: r.src_id,
    dstId: r.dst_id,
    relType: r.rel_type,
    weight: r.weight,
    sourceChunk: r.source_chunk,
    source: r.source ?? "",
  };
}

/**
 * SQLite 邻接表存储实现：
 * - `entities` 表存实体（name 规范化后入库，同实体 upsert 合并）；
 * - `relations` 表存有向边（weight 累加同源频次），src/dst/type 建索引；
 * - 邻域查询为 BFS 多跳 join，百万节点内毫秒级可接受。
 */
export class SqliteGraphStore implements GraphStore {
  private db: DatabaseSync;

  constructor(opts: SqliteGraphStoreOptions) {
    this.db = new DatabaseSync(opts.dbPath);
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
    `);
    this.migrate();
  }

  /**
   * 旧库迁移：
   * 1. v1 的 relations 表无 source 列（当时只有 source_chunk 存 chunk id，
   *    导致按文件名删除恒不命中，removeBySource 实为空操作）——补列；
   * 2. 存量实体/关系没有来源归属，直接进入新的级联删除逻辑会被判为"无依据"而误删。
   *    统一挂到 LEGACY_SOURCE 占位来源下，等 reconcile 按真实来源重建后自然消解。
   */
  private migrate(): void {
    const columns = this.db
      .prepare(`PRAGMA table_info(relations)`)
      .all() as unknown as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "source")) {
      this.db.exec(`ALTER TABLE relations ADD COLUMN source TEXT NOT NULL DEFAULT ''`);
    }
    // 新库在 exec 建表时已具备 source 列；旧库在 ALTER 之后才具备。
    // 无论哪种，都在此统一补建索引，避免初始 exec 在旧库上因缺列而失败。
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source)`);

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

  upsertEntity(e: Entity): void {
    this.db
      .prepare(
        `INSERT INTO entities (id, name, type, props) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, type = excluded.type, props = excluded.props`,
      )
      .run(e.id, e.name, e.type, JSON.stringify(e.props));
  }

  upsertRelation(r: Relation): void {
    this.db
      .prepare(
        `INSERT INTO relations (id, src_id, dst_id, rel_type, weight, source_chunk, source) VALUES (?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET weight = relations.weight + 1,
           source_chunk = excluded.source_chunk,
           source = excluded.source`,
      )
      .run(r.id, r.srcId, r.dstId, r.relType, r.sourceChunk, r.source ?? "");
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
      | EntityRow
      | undefined;
    return row ? toEntity(row) : null;
  }

  findEntitiesByName(name: string, limit = 10): Entity[] {
    const normalized = normalizeName(name);
    if (!normalized) return [];
    // 精确优先
    const exact = this.db
      .prepare(`SELECT * FROM entities WHERE name = ? ORDER BY length(name) LIMIT ?`)
      .all(normalized, limit) as unknown as EntityRow[];
    if (exact.length > 0) return exact.map(toEntity);
    // 包含匹配（规范化名彼此包含）
    const contains = this.db
      .prepare(`SELECT * FROM entities WHERE name LIKE ? ORDER BY length(name) LIMIT ?`)
      .all(`%${normalized}%`, limit) as unknown as EntityRow[];
    return contains.map(toEntity);
  }

  neighbors(
    entityId: string,
    hops: number,
    opts: { maxNodes?: number; minWeight?: number } = {},
  ): Subgraph {
    const maxNodes = opts.maxNodes ?? 64;
    const minWeight = opts.minWeight ?? 1;
    const seed = this.findEntityById(entityId);
    if (!seed) return makeSubgraph([], []);

    const seen = new Set<string>([entityId]);
    const relationIds = new Set<string>();
    let frontier = [entityId];

    for (let h = 0; h < hops; h += 1) {
      if (frontier.length === 0) break;
      const next: string[] = [];
      for (const cur of frontier) {
        const rows = this.db
          .prepare(
            `SELECT * FROM relations WHERE (src_id = ? OR dst_id = ?) AND weight >= ? ORDER BY weight DESC`,
          )
          .all(cur, cur, minWeight) as unknown as RelationRow[];
        for (const row of rows) {
          relationIds.add(row.id);
          const other = row.src_id === cur ? row.dst_id : row.src_id;
          if (!seen.has(other) && seen.size < maxNodes) {
            seen.add(other);
            next.push(other);
          }
        }
      }
      frontier = next;
    }

    const entities: Entity[] = [...seen]
      .map((id) => this.findEntityById(id))
      .filter((e): e is Entity => e !== null);
    const relations: Relation[] = [...relationIds]
      .map((id) => {
        const row = this.db.prepare(`SELECT * FROM relations WHERE id = ?`).get(id) as
          | RelationRow
          | undefined;
        return row ? toRelation(row) : null;
      })
      .filter((r): r is Relation => r !== null);
    return makeSubgraph(entities, relations);
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
        `DELETE FROM entities
         WHERE id NOT IN (SELECT entity_id FROM entity_sources)
           AND id NOT IN (SELECT src_id FROM relations UNION SELECT dst_id FROM relations)`,
      )
      .run();

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
      | SourceRow
      | undefined;
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

  listEntities(opts: { offset?: number; limit?: number; type?: string; search?: string } = {}): Entity[] {
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

  aliasesOf(entityId: string): string[] {
    const rows = this.db
      .prepare(`SELECT alias FROM entity_aliases WHERE entity_id = ? ORDER BY created_at`)
      .all(entityId) as unknown as Array<{ alias: string }>;
    return rows.map((r) => r.alias);
  }

  close(): void {
    this.db.close();
  }
}
