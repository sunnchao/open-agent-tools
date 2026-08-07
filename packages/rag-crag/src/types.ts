/** 检索评估三档。 */
export type Assessment = "correct" | "ambiguous" | "incorrect";

/** 单个知识条带：句级内容 + 相关性标注 + 来源回溯。 */
export interface KnowledgeStrip {
  id: string;
  text: string;
  relevant: boolean;
  source: string;
  chunkIndex: number;
}

/** 检索域产出的一条证据（分块级）。 */
export interface EvidenceChunk {
  source: string;
  chunkIndex: number;
  content: string;
}

/** 检索域产出。 */
export interface RetrievalEvidence {
  domain: string;
  chunks: EvidenceChunk[];
}

/** 评估结果：三档 + 置信度 + 条带级标注。 */
export interface Evaluation {
  assessment: Assessment;
  confidence: number;
  strips: KnowledgeStrip[];
}

/** CRAG 最终产出：注入文本 + 纠正动作记录。 */
export interface CragResult {
  query: string;
  assessment: Assessment;
  confidence: number;
  /** 精炼后的注入文本（带引用）；incorrect 且纠正失败时为空串。 */
  formatted: string;
  /** 纠正动作记录，供 SSE 事件与日志。 */
  actions: string[];
  /** 精炼后的条带级引用（前端展示用）。 */
  citations: KnowledgeStrip[];
}

/** 可插拔检索域：block / graph / web ... 调用方注册。 */
export interface RetrievalDomain {
  name: string;
  retrieve(query: string, opts?: { sources?: string[] }): Promise<RetrievalEvidence>;
}

/** 检索评估器：给定查询与证据，输出三档 + 条带标注。 */
export interface RetrievalEvaluator {
  evaluate(query: string, evidence: RetrievalEvidence[]): Promise<Evaluation>;
}
