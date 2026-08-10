import { createHash } from "node:crypto";
import type { Entity, Relation, Subgraph } from "./types.js";

/** 余弦相似度（等长向量）。 */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** sha1 摘要（16 进制），用于实体/关系稳定键。 */
export function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

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

/** 关系稳定键。 */
export function relationId(srcId: string, relType: string, dstId: string): string {
  return sha1(`${srcId}:${relType}:${dstId}`);
}

/** 关系序列化文本（三元组 + 来源引用）。 */
export function serializeRelation(r: Relation): string {
  return `(${r.srcId}) --${r.relType}--> (${r.dstId}) 来源: ${r.sourceChunk}`;
}

/** 子图序列化为 prompt 文本。 */
export function serializeSubgraph(entities: Entity[], relations: Relation[]): string {
  if (entities.length === 0 && relations.length === 0) return "";
  const lines: string[] = [];
  if (relations.length > 0) {
    lines.push("相关实体与关系:");
    for (const r of relations) {
      lines.push(`- ${serializeRelation(r)}`);
    }
  }
  if (entities.length > 0) {
    lines.push("涉及实体:");
    lines.push(
      `- ${entities.map((e) => `${e.name}(${e.type})`).join("、")}`,
    );
  }
  return lines.join("\n");
}

/** 构造带 formatted() 闭包的子图。 */
export function makeSubgraph(entities: Entity[], relations: Relation[]): Subgraph {
  return {
    entities,
    relations,
    formatted: () => serializeSubgraph(entities, relations),
  };
}
