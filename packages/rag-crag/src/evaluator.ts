import type { Evaluation, EvidenceChunk, KnowledgeStrip, RetrievalEvaluator, RetrievalEvidence } from "./types.js";
import { extractJson } from "@open-agent-tools/rag-graph";

/** 评估器 LLM 通道：调用方注入（可包装 apps/server 的 createLlmClient）。 */
export type EvaluatorChatFn = (system: string, user: string) => Promise<string>;

export interface LlmEvaluatorOptions {
  chat: EvaluatorChatFn;
  /** 每证据最多送入评估的条带数（截断预算），默认 20。 */
  maxStrips?: number;
}

/** 将分块切为句级条带（中文按 。！？；切分，英文按句子边界）。 */
export function splitStrips(chunk: EvidenceChunk, maxStrips = 20): KnowledgeStrip[] {
  const parts = chunk.content
    .split(/(?<=[。！？；!?;])|\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const strips: KnowledgeStrip[] = [];
  for (let i = 0; i < parts.length && strips.length < maxStrips; i += 1) {
    strips.push({
      id: `${chunk.source}:${chunk.chunkIndex}:${i}`,
      text: parts[i]!,
      relevant: true,
      source: chunk.source,
      chunkIndex: chunk.chunkIndex,
    });
  }
  return strips;
}

/**
 * LLM 检索评估器：一次调用完成三档判定 + 条带相关性标注。
 * prompt 要求 JSON 输出 { assessment, confidence, relevant_strips: [stripId...] }。
 */
export class LlmRetrievalEvaluator implements RetrievalEvaluator {
  private chat: EvaluatorChatFn;
  private maxStrips: number;

  constructor(opts: LlmEvaluatorOptions) {
    this.chat = opts.chat;
    this.maxStrips = opts.maxStrips ?? 20;
  }

  async evaluate(query: string, evidence: RetrievalEvidence[]): Promise<Evaluation> {
    const allStrips = evidence.flatMap((e) => e.chunks.flatMap((c) => splitStrips(c, this.maxStrips)));
    if (allStrips.length === 0) {
      return { assessment: "incorrect", confidence: 0, strips: [] };
    }
    const stripList = allStrips
      .map((s, i) => `${i}. [${s.source} #${s.chunkIndex + 1}] ${s.text}`)
      .join("\n");
    const system =
      `你是检索质量评估器。根据用户查询判断给定检索结果是否可用于回答，并标注相关的条带。\n` +
      `评估分三档：correct（结果整体相关，可直接用）；ambiguous（部分相关，需要补充检索）；incorrect（完全不相关）。\n` +
      `只输出 JSON：{"assessment":"correct|ambiguous|incorrect","confidence":0.0-1.0,"relevant_strips":[条带编号]}。不要解释。`;
    const raw = await this.chat(system, `查询: ${query}\n\n检索结果条带:\n${stripList}`);
    const data = extractJson(raw);
    if (!data || typeof data !== "object") {
      return { assessment: "ambiguous", confidence: 0.5, strips: allStrips };
    }
    const assessment = (data as { assessment?: unknown }).assessment;
    const confidence = Number((data as { confidence?: unknown }).confidence);
    const relevant = (data as { relevant_strips?: unknown }).relevant_strips;
    const okAssessment: AssessmentValue[] = ["correct", "ambiguous", "incorrect"];
    const normalized = okAssessment.includes(assessment as AssessmentValue)
      ? (assessment as AssessmentValue)
      : "ambiguous";
    const relevantIds = Array.isArray(relevant)
      ? new Set(relevant.map((r) => Number(r)).filter((n) => Number.isInteger(n)))
      : new Set<number>();
    const strips = allStrips.map((s, i) => ({ ...s, relevant: relevantIds.has(i) }));
    return {
      assessment: normalized,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
      strips,
    };
  }
}

type AssessmentValue = "correct" | "ambiguous" | "incorrect";
