import { DatabaseSync } from "node:sqlite";
import type { Entity, GraphStore, Relation, Subgraph } from "./types.js";
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
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_relations_src ON relations(src_id);
      CREATE INDEX IF NOT EXISTS idx_relations_dst ON relations(dst_id);
      CREATE INDEX IF NOT EXISTS idx_relations_type ON relations(rel_type);
    `);
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
        `INSERT INTO relations (id, src_id, dst_id, rel_type, weight, source_chunk) VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT(id) DO UPDATE SET weight = relations.weight + 1, source_chunk = excluded.source_chunk`,
      )
      .run(r.id, r.srcId, r.dstId, r.relType, r.sourceChunk);
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

  removeBySource(source: string): void {
    // 先删该来源关联的关系，再删不再被任何关系引用的实体
    this.db
      .prepare(`DELETE FROM relations WHERE source_chunk = ?`)
      .run(source);
    this.db
      .prepare(
        `DELETE FROM entities WHERE id NOT IN (
           SELECT src_id FROM relations UNION SELECT dst_id FROM relations
         ) AND id IN (SELECT id FROM entities)`,
      )
      .run();
    // 孤儿实体（既无关系也无来源信息）无法按 source 精确清理，保留属预期：抽取可能跨 chunk 复用实体
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

  close(): void {
    this.db.close();
  }
}
