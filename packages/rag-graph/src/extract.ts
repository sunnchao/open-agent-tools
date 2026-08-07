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

/** 规范化实体名，类型非法时回退 concept。 */
function makeEntity(name: string, type: string, props: Record<string, string> = {}): Entity {
  const normalized = normalizeName(name);
  const safeType = (DEFAULT_ENTITY_TYPES as readonly string[]).includes(type) ? type : "concept";
  return { id: entityId(normalized, safeType), name: normalized, type: safeType, props };
}

function makeRelation(
  src: Entity,
  relType: string,
  dst: Entity,
  sourceChunk: string,
): Relation {
  const safeType = (DEFAULT_RELATION_TYPES as readonly string[]).includes(relType)
    ? relType
    : "related_to";
  return {
    id: relationId(src.id, safeType, dst.id),
    srcId: src.id,
    dstId: dst.id,
    relType: safeType,
    weight: 1,
    sourceChunk,
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
export class LlmGraphExtractor implements GraphExtractor {
  private chat: LlmChatFn;
  private entityTypes: readonly string[];

  constructor(chat: LlmChatFn, opts: { entityTypes?: readonly string[] } = {}) {
    this.chat = chat;
    this.entityTypes = opts.entityTypes ?? DEFAULT_ENTITY_TYPES;
  }

  async extract(chunk: ChunkLike): Promise<ExtractResult> {
    const system =
      `你是知识图谱抽取器。从给定文本抽取实体与关系，只输出 JSON，不要任何解释。\n` +
      `实体 type 只能是以下之一: ${this.entityTypes.join("、")}。\n` +
      `关系 predicate 只能是以下之一: ${DEFAULT_RELATION_TYPES.join("、")}；如无合适谓词用 related_to。\n` +
      `输出格式: {"entities":[{"name":"","type":"","props":{}}],"relations":[{"subject":"","predicate":"","object":""}]}`;
    const raw = await this.chat(system, chunk.content);
    const data = extractJson(raw);
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
          if (!src || !dst) continue;
          const rel = makeRelation(
            src,
            typeof predicate === "string" ? predicate : "related_to",
            dst,
            chunk.id,
          );
          if (!relations.some((r) => r.id === rel.id)) relations.push(rel);
        }
      }
    }
    return { entities, relations };
  }
}

/** 候选词过滤：去除停用词与纯数字。 */
const STOPWORDS = new Set([
  "我们", "你们", "他们", "这个", "那个", "一个", "以及", "或者", "因为", "所以",
  "可以", "需要", "没有", "不是", "就是", "进行", "通过", "以及", "对于", "关于",
  "系统", "用户", "数据", "功能", "问题", "方法",
]);

/** 从文本中提取候选实体名（英文驼峰/大写词 + 中文 2-6 字片段）。 */
export function extractCandidateNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9_]*/g)) {
    const word = match[0]!;
    // 常见小写功能词不构成实体
    if (word.length >= 3 && /[A-Z]/.test(word)) names.add(word);
  }
  // 中文：连续 2-6 个 CJK 字符作为候选
  for (const match of text.matchAll(/[\u4e00-\u9fff]{2,6}/g)) {
    const phrase = match[0]!;
    if (!STOPWORDS.has(phrase)) names.add(phrase);
  }
  return [...names];
}

/**
 * 规则抽取器（无 LLM 时回退）：专有名词/名词短语高频共现建图。
 * - 实体：候选名 + 出现频次；
 * - 关系：同一分块内共现的实体对 → related_to（方向无关，weight 累积由 store 处理）。
 */
export class RuleGraphExtractor implements GraphExtractor {
  async extract(chunk: ChunkLike): Promise<ExtractResult> {
    const candidates = extractCandidateNames(chunk.content);
    const entities = candidates.map((name) => makeEntity(name, "concept"));
    const relations: Relation[] = [];
    for (let i = 0; i < entities.length; i += 1) {
      for (let j = i + 1; j < entities.length; j += 1) {
        const rel = makeRelation(entities[i]!, "related_to", entities[j]!, chunk.id);
        if (!relations.some((r) => r.id === rel.id)) relations.push(rel);
      }
    }
    return { entities, relations };
  }
}
