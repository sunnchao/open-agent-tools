import type { ChunkLike, Entity, ExtractResult, Relation } from "./types.js";
import { entityId, normalizeName, relationId } from "./utils.js";

/** 实体类型白名单（LLM 抽取的 type 字段会被约束到该集合）。 */
export const DEFAULT_ENTITY_TYPES = [
  "person",
  "org",
  "product",
  "tech",
  "place",
  "concept",
] as const;

/** 谓词白名单（LLM 抽取的 predicate 会被映射到该集合，映射失败用 related_to 兜底）。 */
export const DEFAULT_RELATION_TYPES = [
  "supplies",
  "depends_on",
  "part_of",
  "located_in",
  "produced_by",
  "related_to",
] as const;

export type EntityType = (typeof DEFAULT_ENTITY_TYPES)[number];
export type RelationType = (typeof DEFAULT_RELATION_TYPES)[number];

/** 通用 LLM 单次对话函数：调用方注入（可包装 apps/server 的 createLlmClient）。 */
export type LlmChatFn = (system: string, user: string) => Promise<string>;

export interface GraphExtractor {
  /** 从单个分块抽取三元组。 */
  extract(chunk: ChunkLike): Promise<ExtractResult>;
}

/** 抽取过程的可观测统计：解析失败不再静默丢数据。 */
export interface ExtractDiagnostics {
  /** 调用抽取器的次数。 */
  calls: number;
  /** LLM 返回内容无法解析成 JSON 的次数（会产出 0 实体 0 关系）。 */
  parseFailures: number;
  /** 三元组因端点不在本块实体表中被丢弃的次数。 */
  orphanRelations: number;
  /** 被白名单拒绝、回退成 related_to 的谓词次数。 */
  predicateFallbacks: number;
}

/** 抽取器可选实现：暴露失败计数，便于上层日志与健康检查。 */
export interface ObservableExtractor {
  diagnostics(): ExtractDiagnostics;
}

/** 单次抽取的统计载体（每次 extract 重建，供包装器累积）。 */
interface MutableDiagnostics {
  calls: number;
  parseFailures: number;
  orphanRelations: number;
  predicateFallbacks: number;
}

function emptyDiagnostics(): MutableDiagnostics {
  return { calls: 0, parseFailures: 0, orphanRelations: 0, predicateFallbacks: 0 };
}

/**
 * 规范化实体名，类型非法时回退 concept。
 *
 * 注意：实体 id 仍带 type。同名不同 type 会分裂成多个节点，这是历史设计；
 * 上层用 `KnowledgeGraph.resolveDuplicateEntities()` 做消解，而不是在这里改 id 规则
 * （改 id 会让所有存量数据失效）。
 */
function makeEntity(name: string, type: string, props: Record<string, string> = {}): Entity {
  const normalized = normalizeName(name);
  const safeType = (DEFAULT_ENTITY_TYPES as readonly string[]).includes(type) ? type : "concept";
  return { id: entityId(normalized, safeType), name: normalized, type: safeType, props };
}

/**
 * 建边。source 取自所属分块的文档来源，是生命周期级联删除的锚点——
 * 只记 chunk id 无法反查归属文档，删除时会漏。
 *
 * 边 id 由 relationId 计算：对称谓词会按端点排序，使 A→B 与 B→A 归一为同一条边。
 */
function makeRelation(
  src: Entity,
  relType: string,
  dst: Entity,
  chunk: ChunkLike,
  origin: "llm" | "rule",
): Relation {
  const whitelisted = (DEFAULT_RELATION_TYPES as readonly string[]).includes(relType);
  const safeType = whitelisted ? relType : "related_to";
  return {
    id: relationId(src.id, safeType, dst.id),
    srcId: src.id,
    dstId: dst.id,
    relType: safeType,
    weight: 1,
    sourceChunk: chunk.id,
    source: chunk.source,
    origin,
  };
}

/** 从 LLM 回复中稳健提取 JSON（容忍 ```json 代码块包裹与前后噪声）。 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]!.trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * LLM 抽取器：一次调用同时输出实体与三元组（JSON mode）。
 * 无 Key / 调用失败时由调用方回退 RuleGraphExtractor。
 */
export class LlmGraphExtractor implements GraphExtractor, ObservableExtractor {
  private chat: LlmChatFn;
  private entityTypes: readonly string[];
  private stats: MutableDiagnostics = emptyDiagnostics();

  constructor(chat: LlmChatFn, opts: { entityTypes?: readonly string[] } = {}) {
    this.chat = chat;
    this.entityTypes = opts.entityTypes ?? DEFAULT_ENTITY_TYPES;
  }

  diagnostics(): ExtractDiagnostics {
    return { ...this.stats };
  }

  async extract(chunk: ChunkLike): Promise<ExtractResult> {
    const system =
      `你是知识图谱抽取器。从给定文本抽取实体与关系，只输出 JSON，不要任何解释。\n` +
      `实体 type 只能是以下之一: ${this.entityTypes.join("、")}。\n` +
      `关系 predicate 只能是以下之一: ${DEFAULT_RELATION_TYPES.join("、")}；如无合适谓词用 related_to。\n` +
      `输出格式: {"entities":[{"name":"","type":"","props":{}}],"relations":[{"subject":"","predicate":"","object":""}]}`;
    const raw = await this.chat(system, chunk.content);
    this.stats.calls += 1;
    const data = extractJson(raw);
    if (data === null) {
      // 解析失败会静默产出 0 实体 0 关系；计数暴露给上层，避免"抽了但没抽到"无声无息
      this.stats.parseFailures += 1;
      return { entities: [], relations: [] };
    }
    return this.normalize(data, chunk);
  }

  private normalize(data: unknown, chunk: ChunkLike): ExtractResult {
    const entities: Entity[] = [];
    const byName = new Map<string, Entity>();
    if (data && typeof data === "object") {
      const rawEntities = (data as { entities?: unknown }).entities;
      if (Array.isArray(rawEntities)) {
        for (const item of rawEntities) {
          if (!item || typeof item !== "object") continue;
          const { name, type, props } = item as { name?: unknown; type?: unknown; props?: unknown };
          if (typeof name !== "string" || !name.trim()) continue;
          const entity = makeEntity(
            name,
            typeof type === "string" ? type : "concept",
            props && typeof props === "object" && !Array.isArray(props)
              ? Object.fromEntries(
                  Object.entries(props as Record<string, unknown>)
                    .filter(([, v]) => typeof v === "string")
                    .map(([k, v]) => [k, v as string]),
                )
              : {},
          );
          if (!byName.has(entity.name)) {
            byName.set(entity.name, entity);
            entities.push(entity);
          }
        }
      }
    }
    const relations: Relation[] = [];
    if (data && typeof data === "object") {
      const rawRelations = (data as { relations?: unknown }).relations;
      if (Array.isArray(rawRelations)) {
        for (const item of rawRelations) {
          if (!item || typeof item !== "object") continue;
          const { subject, predicate, object } = item as {
            subject?: unknown;
            predicate?: unknown;
            object?: unknown;
          };
          if (typeof subject !== "string" || typeof object !== "string") continue;
          const src = byName.get(normalizeName(subject));
          const dst = byName.get(normalizeName(object));
          if (!src || !dst) {
            // 端点不在本块实体表里：这条关系无法解析成实体名，如实计数后丢弃
            this.stats.orphanRelations += 1;
            continue;
          }
          const rawPredicate = typeof predicate === "string" ? predicate : "related_to";
          if (!(DEFAULT_RELATION_TYPES as readonly string[]).includes(rawPredicate)) {
            this.stats.predicateFallbacks += 1;
          }
          const rel = makeRelation(src, rawPredicate, dst, chunk, "llm");
          if (!relations.some((r) => r.id === rel.id)) relations.push(rel);
        }
      }
    }
    return { entities, relations };
  }
}

/** 候选词过滤：去除停用词（常见动词/虚词/通用名词）。 */
const STOPWORDS = new Set([
  "我们", "你们", "他们", "这个", "那个", "一个", "以及", "或者", "因为", "所以",
  "可以", "需要", "没有", "不是", "就是", "进行", "通过", "对于", "关于",
  "系统", "用户", "数据", "功能", "问题", "方法", "支持", "使用", "包括",
  "提供", "依赖", "发布", "存在", "具有", "属于", "成为", "导致", "影响",
  "以及", "其中", "此外", "同时", "当前", "现在", "如果", "是否",
]);

/** 中文句读边界（分句与切块共用）。 */
const SENTENCE_BOUNDARY = /[。！？；.!?;\n]/;

/**
 * 从文本中提取候选实体名：
 * - 英文驼峰/大写词（≥3 字符且含大写）；
 * - 中文：以标点/空白切为块，块内 2-6 字完整短语为候选（>6 字的中文长串多为句子，跳过避免残词）。
 */
export function extractCandidateNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9_]*/g)) {
    const word = match[0]!;
    // 常见小写功能词不构成实体
    if (word.length >= 3 && /[A-Z]/.test(word)) names.add(word);
  }
  // 中文：以标点/空白切块，避免滑窗把长句切成残词
  for (const block of text.split(/[\s，,、：:（）()【】《》"'“”]+/)) {
    const phrase = block.replace(SENTENCE_BOUNDARY, "");
    if (phrase.length < 2 || phrase.length > 6) continue; // 跳过 >6 字长串（多为句子）
    if (!STOPWORDS.has(phrase)) names.add(phrase);
  }
  return [...names];
}

/** 按句读边界切分文本为句子（规则抽取的共现窗口），保留句读标点。 */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？；.!?;])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 规则抽取器（无 LLM 时回退）：句内共现建图。
 * - 实体：候选名（标点切块 + 停用词过滤，无残词）；
 * - 关系：同一句内共现的实体对 → related_to（方向无关），替代整块全连接，显著降噪。
 *
 * 这类边的 origin 标记为 `rule`：谓词恒为 related_to 且没有真实语义，
 * 检索排序时按谓词特异性降权（见 `relationSpecificity`），避免共现噪声挤占候选。
 */
export class RuleGraphExtractor implements GraphExtractor {
  async extract(chunk: ChunkLike): Promise<ExtractResult> {
    const candidates = extractCandidateNames(chunk.content);
    const entities = candidates.map((name) => makeEntity(name, "concept"));
    const byName = new Map(entities.map((e) => [e.name, e]));
    const relations: Relation[] = [];
    const seen = new Set<string>();
    for (const sentence of splitSentences(chunk.content)) {
      const inSentence = extractCandidateNames(sentence)
        .map((name) => byName.get(normalizeName(name)))
        .filter((e): e is Entity => e !== undefined);
      for (let i = 0; i < inSentence.length; i += 1) {
        for (let j = i + 1; j < inSentence.length; j += 1) {
          const rel = makeRelation(inSentence[i]!, "related_to", inSentence[j]!, chunk, "rule");
          if (!seen.has(rel.id)) {
            seen.add(rel.id);
            relations.push(rel);
          }
        }
      }
    }
    return { entities, relations };
  }
}

/**
 * Gleaning 包装器：首轮抽完后用更强硬的 prompt 追问遗漏，把新增结果并回。
 *
 * GraphRAG / LightRAG 都依赖这一步提召回：单轮抽取在信息密集分块上容易漏实体。
 * 合并天然幂等——实体按规范化名去重，关系按稳定 id 去重。
 */
export class GleaningExtractor implements GraphExtractor, ObservableExtractor {
  private inner: GraphExtractor;
  private rounds: number;
  private extraInstruction: string;

  constructor(
    inner: GraphExtractor,
    opts: { rounds?: number; extraInstruction?: string } = {},
  ) {
    this.inner = inner;
    this.rounds = Math.max(1, opts.rounds ?? 1);
    this.extraInstruction =
      opts.extraInstruction ??
      "上一轮你可能遗漏了一些实体和关系。请仔细再检查一遍文本，补充所有尚未抽取的实体与它们之间的关系。";
  }

  diagnostics(): ExtractDiagnostics {
    const observable = this.inner as Partial<ObservableExtractor>;
    return (
      observable.diagnostics?.() ?? {
        calls: 0,
        parseFailures: 0,
        orphanRelations: 0,
        predicateFallbacks: 0,
      }
    );
  }

  async extract(chunk: ChunkLike): Promise<ExtractResult> {
    const first = await this.inner.extract(chunk);
    if (this.rounds <= 1) return first;
    let merged = first;
    for (let round = 0; round < this.rounds - 1; round += 1) {
      const again = await this.inner.extract({
        ...chunk,
        content: `${chunk.content}\n\n【补充要求】${this.extraInstruction}`,
      });
      merged = mergeExtractResults(merged, again);
      // 本轮没新增任何东西说明已抽全，提前结束省 token
      if (again.entities.length === 0 && again.relations.length === 0) break;
    }
    return merged;
  }
}

/** 合并两次抽取结果：实体按 id、关系按稳定 id 去重，首轮优先。 */
export function mergeExtractResults(a: ExtractResult, b: ExtractResult): ExtractResult {
  const entities = [...a.entities];
  const entityIds = new Set(entities.map((e) => e.id));
  for (const entity of b.entities) {
    if (entityIds.has(entity.id)) continue;
    entityIds.add(entity.id);
    entities.push(entity);
  }
  const relations = [...a.relations];
  const relationIds = new Set(relations.map((r) => r.id));
  for (const relation of b.relations) {
    if (relationIds.has(relation.id)) continue;
    relationIds.add(relation.id);
    relations.push(relation);
  }
  return { entities, relations };
}
