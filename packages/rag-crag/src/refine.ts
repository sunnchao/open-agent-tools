import type { KnowledgeStrip } from "./types.js";

export interface RefinerOptions {
  /** 注入文本字符预算，默认 1500。 */
  budgetChars?: number;
}

/**
 * 知识条带精炼（decompose-then-recompose）：
 * 过滤无关条带，重组为带引用的精简文本，替代整块拼接。
 */
export class KnowledgeRefiner {
  private budgetChars: number;

  constructor(opts: RefinerOptions = {}) {
    this.budgetChars = opts.budgetChars ?? 1500;
  }

  /** 仅保留相关条带，重组为带【来源】引用的文本。 */
  recompose(strips: KnowledgeStrip[], budgetChars = this.budgetChars): string {
    const relevant = strips.filter((s) => s.relevant);
    if (relevant.length === 0) return "";

    const lines: string[] = [];
    let used = 0;
    for (const strip of relevant) {
      const line = `【来源: ${strip.source} · 第${strip.chunkIndex + 1}段】\n${strip.text}`;
      if (used + line.length > budgetChars && lines.length > 0) break;
      lines.push(line);
      used += line.length;
    }
    return lines.join("\n\n");
  }

  /** 精炼后的条带级引用（前端展示）。 */
  citations(strips: KnowledgeStrip[]): KnowledgeStrip[] {
    return strips.filter((s) => s.relevant);
  }
}
