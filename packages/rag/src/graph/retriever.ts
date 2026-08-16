import type { Entity, GraphQueryResult, GraphStore, Relation, Subgraph } from "./types.js";
import { cosine } from "./utils.js";

/** 轻量 embeddings 接口（避免强依赖 langchain，调用方可注入任意实现）。 */
export interface EmbeddingsLike {
  embedDocuments(texts: string[]): Promise<number[][]>;
}

export interface GraphRetrieverOptions {
  /** BFS 扩展跳数，默认 2。 */
  maxHops?: number;
  /** 子图节点上限（含种子），防爆炸，默认 64。 */
  maxNodes?: number;
  /** 关系权重截断，默认 1。 */
  minWeight?: number;
  /** 种子定位的候选词上限，默认 20。 */
  seedLimit?: number;
}

/**
 * 图检索器：种子实体定位 + 子图多跳扩展 + 序列化。
 *
 * 种子定位策略：
 * 1. 查询串整体做实体名精确/包含匹配；
 * 2. 未命中时拆分为候选词（英文词 + 中文 2-6 字片段）逐个匹配；
 * 3. 注入 embeddings 时，名称匹配为空再对实体名做向量 top-k 兜底（口语化表述可命中）；
 * 4. 仍未命中 → 返回空子图（调用方如实说明）。
 */
export class GraphRetriever {
  private store: GraphStore;
  private embeddings?: EmbeddingsLike;

  constructor(store: GraphStore, opts: { embeddings?: EmbeddingsLike } = {}) {
    this.store = store;
    this.embeddings = opts.embeddings;
  }

  /** 从查询文本中拆分候选词。 */
  private static splitQueryTerms(query: string): string[] {
    const terms = new Set<string>();
    for (const match of query.matchAll(/[A-Za-z][A-Za-z0-9_]*/g)) {
      if (match[0]!.length >= 2) terms.add(match[0]!);
    }
    for (const match of query.matchAll(/[\u4e00-\u9fff]{2,4}/g)) {
      terms.add(match[0]!);
    }
    return [...terms];
  }

  /** 种子定位：返回去重后的候选实体。 */
  async locateSeeds(query: string, limit = 20): Promise<Entity[]> {
    const seen = new Map<string, Entity>();
    const add = (entity: Entity | null) => {
      if (entity && !seen.has(entity.id)) seen.set(entity.id, entity);
    };
    // 1) 整体匹配
    for (const entity of this.store.findEntitiesByName(query, limit)) add(entity);
    // 2) 别名匹配（共指："OpenAI 公司" → openai）
    if (seen.size === 0) {
      const aliasHit = this.store.findByAlias(query);
      if (aliasHit) add(aliasHit);
    }
    // 3) 候选词逐个匹配
    for (const term of GraphRetriever.splitQueryTerms(query)) {
      if (seen.size >= limit) break;
      for (const entity of this.store.findEntitiesByName(term, Math.max(1, limit - seen.size))) {
        add(entity);
        if (seen.size >= limit) break;
      }
      if (seen.size === 0) {
        const aliasHit = this.store.findByAlias(term);
        if (aliasHit) add(aliasHit);
      }
    }
    // 4) 名称/别名匹配为空 → 向量兜底（口语化/同义表述可命中）
    if (seen.size === 0 && this.embeddings && limit > 0) {
      const all = this.store.listEntities({ limit: Math.max(limit, 100) });
      if (all.length > 0) {
        const [qv, entityVectors] = await Promise.all([
          this.embeddings.embedDocuments([query]),
          this.embeddings.embedDocuments(all.map((e) => e.name)),
        ]);
        const q = qv[0] ?? [];
        const ranked = all
          .map((entity, index) => ({ entity, score: cosine(q, entityVectors[index] ?? []) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
        for (const hit of ranked) {
          if (hit.score > 0.3) add(hit.entity); // 阈值以下视为不相关
        }
      }
    }
    return [...seen.values()];
  }

  /** 子图扩展：以种子为起点 BFS，去重合并各种子邻域。 */
  expand(seedIds: string[], opts: GraphRetrieverOptions = {}): Subgraph {
    const maxHops = opts.maxHops ?? 2;
    const maxNodes = opts.maxNodes ?? 64;
    const minWeight = opts.minWeight ?? 1;

    const entityMap = new Map<string, Entity>();
    const relationMap = new Map<string, Relation>();
    const visited = new Set<string>();

    const collect = (id: string, hops: number) => {
      if (visited.has(id) || entityMap.size >= maxNodes) return;
      visited.add(id);
      const entity = this.store.findEntityById(id);
      if (!entity) return;
      entityMap.set(id, entity);
      // 已到最大跳数：本层实体只入子图，不再展开其邻居
      if (hops >= maxHops || entityMap.size >= maxNodes) return;
      const sub = this.store.neighbors(id, 1, { minWeight, maxNodes });
      for (const rel of sub.relations) {
        if (!relationMap.has(rel.id)) relationMap.set(rel.id, rel);
      }
      for (const neighbor of sub.entities) {
        if (!entityMap.has(neighbor.id) && entityMap.size < maxNodes) {
          entityMap.set(neighbor.id, neighbor);
          collect(neighbor.id, hops + 1);
        }
      }
    };

    for (const seedId of seedIds) collect(seedId, 0);
    // 确保种子必然出现在子图（即使被 maxNodes 截断）
    for (const seedId of seedIds) {
      const entity = this.store.findEntityById(seedId);
      if (entity && !entityMap.has(seedId)) entityMap.set(seedId, entity);
    }
    return {
      entities: [...entityMap.values()],
      relations: [...relationMap.values()],
      formatted: () => serializeSubgraphEntities([...entityMap.values()], [...relationMap.values()]),
    };
  }

  /** 检索门面：定位种子 → 扩展子图。 */
  async retrieve(query: string, opts: GraphRetrieverOptions = {}): Promise<GraphQueryResult> {
    const seeds = await this.locateSeeds(query, opts.seedLimit);
    if (seeds.length === 0) {
      return { query, seeds: [], subgraph: null };
    }
    const subgraph = this.expand(
      seeds.map((s) => s.id),
      opts,
    );
    return { query, seeds, subgraph };
  }
}

function serializeSubgraphEntities(
  entities: Entity[],
  relations: Relation[],
): string {
  const lines: string[] = [];
  if (relations.length > 0) {
    lines.push("相关实体与关系:");
    for (const r of relations) {
      const src = entities.find((e) => e.id === r.srcId)?.name ?? r.srcId;
      const dst = entities.find((e) => e.id === r.dstId)?.name ?? r.dstId;
      lines.push(`- (${src}) --${r.relType}--> (${dst}) 来源: ${r.sourceChunk}`);
    }
  }
  if (entities.length > 0) {
    lines.push(`涉及实体: ${entities.map((e) => `${e.name}(${e.type})`).join("、")}`);
  }
  return lines.join("\n");
}
