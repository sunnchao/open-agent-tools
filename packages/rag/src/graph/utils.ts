import { sha1 } from "../utils.js";
import type { Entity, Relation, RelationOrigin, Subgraph } from "./types.js";

export { cosine, sha1 } from "../utils.js";

/** 全角字符转半角（ASCII 可见区）。 */
function toHalfWidth(input: string): string {
  let out = "";
  for (const ch of input) {
    const code = ch.codePointAt(0);
    if (code !== undefined && code >= 0xff01 && code <= 0xff5e) {
      out += String.fromCodePoint(code - 0xfee0);
    } else if (ch === "\u3000") {
      out += " ";
    } else {
      out += ch;
    }
  }
  return out;
}

/** 实体名称规范化：trim + 全半角归一 + 英文小写折叠 + 内部空白折叠。 */
export function normalizeName(name: string): string {
  return toHalfWidth(name).trim().toLowerCase().replace(/\s+/g, " ");
}

/** 实体稳定键。 */
export function entityId(name: string, type: string): string {
  return sha1(`${normalizeName(name)}:${type}`);
}

/**
 * 方向不对称的谓词集合。
 *
 * 这些谓词的方向有语义（A supplies B ≠ B supplies A），id 必须保留端点顺序。
 * 未列出的谓词（含 related_to）一律按对称处理：端点排序后再算 id，
 * 使 A→B 与 B→A 归一为同一条边，避免同一事实存两份、权重被摊薄。
 */
const ASYMMETRIC_RELATION_TYPES = new Set([
  "supplies",
  "depends_on",
  "part_of",
  "located_in",
  "produced_by",
  "has_column",
  "references",
]);

/** 谓词是否方向无关（related_to 等）。 */
export function isSymmetricRelation(relType: string): boolean {
  return !ASYMMETRIC_RELATION_TYPES.has(relType);
}

/** 关系稳定键；对称谓词按端点排序，保证 A→B 与 B→A 得到同一个 id。 */
export function relationId(srcId: string, relType: string, dstId: string): string {
  if (isSymmetricRelation(relType) && srcId > dstId) {
    return sha1(`${dstId}:${relType}:${srcId}`);
  }
  return sha1(`${srcId}:${relType}:${dstId}`);
}

/**
 * 谓词特异性系数，供排序使用。
 *
 * `related_to` 是抽取失败时的兜底谓词，几乎不携带语义（实测在真实语料里可占
 * 一半以上的边）；句内共现边同样是噪声。两者在子图候选排序里按较低系数计入，
 * 避免噪声边挤掉真正的语义关系。
 */
export function relationSpecificity(relType: string, origin?: RelationOrigin): number {
  const base = relType === "related_to" ? 0.4 : relType === "references" ? 0.8 : 1;
  // 规则抽取的边恒为 related_to，再乘一次通道系数，等价于共现边整体降权
  return origin === "rule" ? base * 0.5 : base;
}

/** 关系序列化文本（三元组 + 来源引用）。 */
export function serializeRelation(r: Relation, names?: ReadonlyMap<string, string>): string {
  const src = names?.get(r.srcId) ?? r.srcId;
  const dst = names?.get(r.dstId) ?? r.dstId;
  return `(${src}) --${r.relType}--> (${dst}) 来源: ${r.sourceChunk}`;
}

/** 子图序列化为 prompt 文本。 */
export function serializeSubgraph(entities: Entity[], relations: Relation[]): string {
  const lines: string[] = [];
  if (relations.length > 0) {
    const names = new Map(entities.map((entity) => [entity.id, entity.name]));
    lines.push("相关实体与关系:");
    for (const r of relations) {
      lines.push(`- ${serializeRelation(r, names)}`);
    }
  }
  if (entities.length > 0) {
    lines.push(`涉及实体: ${entities.map((e) => `${e.name}(${e.type})`).join("、")}`);
  }
  const described = entities
    .map((entity) => ({ entity, props: entityProps(entity) }))
    .filter(({ props }) => props.length > 0);
  if (described.length > 0) {
    lines.push("实体属性:");
    for (const { entity, props } of described) {
      lines.push(`- ${entity.name}: ${props.join("；")}`);
    }
  }
  return lines.join("\n");
}

/** 非空字符串属性按 key 排序，保证图谱浏览与检索上下文使用同一份事实文本。 */
function entityProps(entity: Entity): string[] {
  const props = entity.props;
  if (!props || typeof props !== "object") return [];
  return Object.entries(props)
    .filter(([, value]) => typeof value === "string" && value.trim().length > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}: ${String(value).trim()}`);
}

/** 构造带 formatted() 闭包的子图。 */
export function makeSubgraph(entities: Entity[], relations: Relation[]): Subgraph {
  return {
    entities,
    relations,
    formatted: () => serializeSubgraph(entities, relations),
  };
}
