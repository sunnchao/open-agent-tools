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
  /**
   * 限定图谱来源白名单。为空数组时不检索；缺省表示不限来源。
   * 过滤同时作用于种子定位与子图扩展，避免从相邻文档泄漏内容。
   */
  sources?: readonly string[];
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

  /** 候选词上限：滑窗会放大中文片段数量，避免长问句把定位退化成全库扫描。 */
  private static readonly MAX_QUERY_TERMS = 64;

  /** 向量兜底的入池门槛：低于此值视为「问句与图谱无关」，宁可零命中也不塞噪声。 */
  private static readonly MIN_VECTOR_SEED_SCORE = 0.55;

  /** 向量兜底的相对带宽：只保留与最高分相差不超过该值的实体。 */
  private static readonly VECTOR_SEED_SCORE_BAND = 0.12;

  /**
   * 从查询文本中拆分候选词（英文 token + 中文 2-4 字重叠片段）。
   *
   * 中文必须用重叠滑窗而不是贪婪切块：`/[\u4e00-\u9fff]{2,4}/g` 会把
   * 「卡莎有哪些技能」切成「卡莎有哪」「些技能」，跨过实体名边界后一个都命中不了，
   * 而滑窗能同时产出「卡莎」。长词优先，兼顾精确度。
   */
  private static splitQueryTerms(query: string): string[] {
    const terms: string[] = [];
    const seen = new Set<string>();
    const add = (term: string) => {
      if (!term || seen.has(term) || terms.length >= GraphRetriever.MAX_QUERY_TERMS) return;
      seen.add(term);
      terms.push(term);
    };
    for (const match of query.matchAll(/[A-Za-z][A-Za-z0-9_]*/g)) {
      if (match[0]!.length >= 2) add(match[0]!);
    }
    for (const match of query.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
      const run = match[0]!;
      for (const size of [4, 3, 2]) {
        for (let index = 0; index + size <= run.length; index += 1) {
          add(run.slice(index, index + size));
        }
      }
    }
    return terms;
  }

  /** 种子定位：返回去重后的候选实体。 */
  async locateSeeds(query: string, limit = 20, sources?: readonly string[]): Promise<Entity[]> {
    const seen = new Map<string, Entity>();
    if (sources?.length === 0) return [];
    const add = (entity: Entity | null) => {
      if (entity && !seen.has(entity.id)) seen.set(entity.id, entity);
    };
    const byName = (name: string, max: number): Entity[] =>
      sources
        ? (this.store.findEntitiesByNameInSources?.(name, sources, max) ??
          this.store
            .findEntitiesByName(name, max)
            .filter((entity) =>
              this.store.entitySources?.(entity.id).some((source) => sources.includes(source)),
            ))
        : this.store.findEntitiesByName(name, max);
    const byAlias = (name: string): Entity | null =>
      sources
        ? (this.store.findByAliasInSources?.(name, sources) ??
          this.filterAliasHit(this.store.findByAlias(name), sources))
        : this.store.findByAlias(name);
    // 1) 整体匹配
    for (const entity of byName(query, limit)) add(entity);
    // 2) 别名匹配（共指："OpenAI 公司" → openai）
    if (seen.size === 0) {
      const aliasHit = byAlias(query);
      if (aliasHit) add(aliasHit);
    }
    // 3) 候选词逐个匹配
    for (const term of GraphRetriever.splitQueryTerms(query)) {
      if (seen.size >= limit) break;
      for (const entity of byName(term, Math.max(1, limit - seen.size))) {
        add(entity);
        if (seen.size >= limit) break;
      }
      if (seen.size === 0) {
        const aliasHit = byAlias(term);
        if (aliasHit) add(aliasHit);
      }
    }
    // 4) 名称/别名匹配为空 → 向量兜底（口语化/同义表述可命中）
    if (seen.size === 0 && this.embeddings && limit > 0) {
      const all = this.store.listEntities({ limit: Math.max(limit, 100) }).filter((entity) => {
        if (!sources) return true;
        return (
          this.store.entitySources?.(entity.id).some((source) => sources.includes(source)) ?? false
        );
      });
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
        // 阈值必须够高：短中文串在通用 embedding 上的基线余弦就有 0.4-0.6，
        // 旧阈值 0.3 会让「今天天气怎么样」也命中 20 个实体，把噪声当检索结果。
        // 只保留接近最高分的命中，避免长尾弱相关实体把子图灌满。
        const top = ranked[0]?.score ?? 0;
        if (top >= GraphRetriever.MIN_VECTOR_SEED_SCORE) {
          for (const hit of ranked) {
            if (hit.score < top - GraphRetriever.VECTOR_SEED_SCORE_BAND) break;
            add(hit.entity);
          }
        }
      }
    }
    return [...seen.values()];
  }

  private filterAliasHit(entity: Entity | null, sources: readonly string[]): Entity | null {
    if (!entity) return null;
    const scoped = this.store.entitySources?.(entity.id);
    return scoped?.some((source) => sources.includes(source)) ? entity : null;
  }

  /** 子图扩展：以种子为起点 BFS，去重合并各种子邻域。 */
  expand(seedIds: string[], opts: GraphRetrieverOptions = {}): Subgraph {
    const maxHops = opts.maxHops ?? 2;
    const maxNodes = opts.maxNodes ?? 64;
    const minWeight = opts.minWeight ?? 1;
    const sources = opts.sources;
    if (sources?.length === 0) return { entities: [], relations: [], formatted: () => "" };
    const sourceSet = sources ? new Set(sources) : null;
    const isAllowedEntity = (entityId: string): boolean =>
      sourceSet === null ||
      (this.store.entitySources?.(entityId).some((source) => sourceSet.has(source)) ?? false);

    const entityMap = new Map<string, Entity>();
    const relationMap = new Map<string, Relation>();
    const visited = new Set<string>();

    const collect = (id: string, hops: number) => {
      if (visited.has(id) || entityMap.size >= maxNodes) return;
      visited.add(id);
      const entity = this.store.findEntityById(id);
      if (!entity || !isAllowedEntity(id)) return;
      entityMap.set(id, entity);
      // 已到最大跳数：本层实体只入子图，不再展开其邻居
      if (hops >= maxHops || entityMap.size >= maxNodes) return;
      const sub = this.store.neighbors(id, 1, {
        minWeight,
        maxNodes,
        ...(sources ? { sources } : {}),
      });
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

    // 种子先占预算再出发：否则种子重加会突破 maxNodes（曾实测 64 上限返回 76 个实体）。
    // 种子是本次检索的锚点，必须优先保证它们出现在子图里；标记 visited 会阻断扩展，
    // 所以这里只入图、随后仍交给 collect 正常展开。
    for (const seedId of seedIds) {
      if (entityMap.size >= maxNodes) break;
      const entity = this.store.findEntityById(seedId);
      if (entity && isAllowedEntity(seedId)) entityMap.set(seedId, entity);
    }
    for (const seedId of seedIds) collect(seedId, 0);
    // maxNodes 会截断邻居实体，但关系是按邻居查询批量收集的：
    // 不闭合就会把被截断的一端序列化成裸 40 位实体 id，检索文本直接失去可读性。
    // 只保留两端都在子图内的关系，保证每条三元组都能解析出实体名。
    const relations = [...relationMap.values()].filter(
      (relation) => entityMap.has(relation.srcId) && entityMap.has(relation.dstId),
    );
    return {
      entities: [...entityMap.values()],
      relations,
      formatted: () => serializeSubgraphEntities([...entityMap.values()], relations),
    };
  }

  /** 检索门面：定位种子 → 扩展子图。 */
  async retrieve(query: string, opts: GraphRetrieverOptions = {}): Promise<GraphQueryResult> {
    if (opts.sources?.length === 0) {
      return { query, seeds: [], subgraph: null };
    }
    const seeds = await this.locateSeeds(query, opts.seedLimit, opts.sources);
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

function serializeSubgraphEntities(entities: Entity[], relations: Relation[]): string {
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
  // 实体属性是抽取阶段花 LLM 成本换来的事实（称号/英文名/类别…）。
  // 只给名字和关系等于把它们丢掉，问「XX 有哪些技能」这类问题就永远答不出来。
  const described = entities.filter((entity) => entityProps(entity).length > 0);
  if (described.length > 0) {
    lines.push("实体属性:");
    for (const entity of described) {
      lines.push(`- ${entity.name}: ${entityProps(entity).join("；")}`);
    }
  }
  return lines.join("\n");
}

/** 实体的非空字符串属性，按 key 排序保证输出稳定可比对。 */
function entityProps(entity: Entity): string[] {
  const props = entity.props;
  if (!props || typeof props !== "object") return [];
  return Object.entries(props)
    .filter(([, value]) => typeof value === "string" && value.trim().length > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}: ${String(value).trim()}`);
}
