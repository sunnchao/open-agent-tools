/**
 * 事实抽取管线：一轮问答 → 候选事实 → 写入待审核队列。
 *
 * 设计约束（见技术方案 §6）：
 * - 异步、可失败：抽取失败只记 trace，绝不影响回复；
 * - 默认 unreviewed=1，自动注入面只吃已审核条目；
 * - 主体必须显式，不把“同事不吃辣”记到发言人头上；
 * - 冲突走 supersede（保留历史），删除只走 forget。
 */
import type { LlmClient } from "../providers/clients/index.js";
import { logTrace, truncate } from "../../platform/trace.js";
import {
  isForgottenSession,
  recordLineage,
  writeFact,
  type MemoryConfidence,
  type MemoryKind,
  type MemoryScopeKind,
} from "./store.js";

/** 抽取结果的最小结构；模型输出经校验后才落库。 */
export interface ExtractedFact {
  slug: string;
  kind: MemoryKind;
  subject: string;
  body: string;
  confidence?: MemoryConfidence;
  validFrom?: string;
  /** 为 true 表示该事实属于群而不是个人。 */
  groupScoped?: boolean;
}

const KIND_BY_NAME: Record<string, MemoryKind> = {
  preference: "preference",
  fact: "fact",
  decision: "decision",
  constraint: "constraint",
};
const CONFIDENCE_BY_NAME: Record<string, MemoryConfidence> = {
  high: "high",
  medium: "medium",
  low: "low",
  unknown: "unknown",
};

const EXTRACT_SYSTEM_PROMPT = [
  "你是记忆抽取器。从对话中提取值得长期记住的事实，输出严格 JSON。",
  "只提取用户明确陈述的内容；忽略助手建议、假设、引用与临时闲聊。",
  "字段：slug（英文短横线）、kind（preference/fact/decision/constraint）、subject（事实关于谁或什么，必须具体）、body（一句话中文事实）、confidence（high/medium/low）、validFrom（YYYY-MM-DD，可省略）、groupScoped（该事实属于整个群而非个人时为 true）。",
  '输出格式：{"facts":[...]}。没有可记的内容就输出 {"facts":[]}。',
].join("\n");

/** 从模型自由文本中取第一个 JSON 对象；失败返回 null。 */
export function parseExtraction(raw: string): ExtractedFact[] {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || !("facts" in parsed)) return [];
  const facts = parsed.facts;
  if (!Array.isArray(facts)) return [];
  const result: ExtractedFact[] = [];
  for (const item of facts) {
    if (!item || typeof item !== "object") continue;
    const slug = "slug" in item && typeof item.slug === "string" ? item.slug.trim() : "";
    const subject = "subject" in item && typeof item.subject === "string" ? item.subject.trim() : "";
    const body = "body" in item && typeof item.body === "string" ? item.body.trim() : "";
    const kindName = "kind" in item && typeof item.kind === "string" ? item.kind : "";
    const kind = KIND_BY_NAME[kindName];
    if (!slug || !subject || !body || !kind) continue;
    const confidenceName =
      "confidence" in item && typeof item.confidence === "string" ? item.confidence : "";
    const confidence = CONFIDENCE_BY_NAME[confidenceName];
    const validFrom =
      "validFrom" in item && typeof item.validFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.validFrom)
        ? item.validFrom
        : undefined;
    result.push({
      slug: slug.slice(0, 80),
      kind,
      subject: subject.slice(0, 200),
      body: body.slice(0, 1_000),
      ...(confidence ? { confidence } : {}),
      ...(validFrom ? { validFrom } : {}),
      ...("groupScoped" in item && item.groupScoped === true ? { groupScoped: true } : {}),
    });
  }
  return result.slice(0, 8);
}

export interface ExtractMemoryInput {
  llm: LlmClient;
  model: string;
  workspaceId: string;
  sessionId: string;
  channelId?: string | null;
  /** person 作用域键；缺省时只允许 groupScoped 事实入库。 */
  personId?: string | null;
  groupScopeKey?: string | null;
  question: string;
  answer: string;
  messageId?: string | null;
  actor?: string | null;
}

/**
 * 跑一轮抽取并落库。返回写入条数，失败返回 0（调用方不感知异常）。
 * 会话已遗忘时直接跳过，保证“删了不会自己回来”。
 */
export async function extractAndStoreMemory(input: ExtractMemoryInput): Promise<number> {
  if (isForgottenSession(input.workspaceId, input.sessionId)) return 0;
  let facts: ExtractedFact[];
  try {
    const completion = await input.llm.complete({
      model: input.model,
      messages: [
        { role: "system", content: EXTRACT_SYSTEM_PROMPT },
        { role: "user", content: `用户：${input.question}\n助手：${input.answer}` },
      ],
    });
    facts = parseExtraction(completion.content);
  } catch (error) {
    logTrace("memory.extract_failed", { error: truncate(String(error), 200) }, "warn");
    return 0;
  }
  if (facts.length === 0) return 0;

  let written = 0;
  for (const fact of facts) {
    const groupScoped = fact.groupScoped === true || !input.personId;
    if (groupScoped && !input.groupScopeKey) continue;
    const scopeKind: MemoryScopeKind = groupScoped ? "group" : "person";
    const scopeKey = groupScoped ? input.groupScopeKey! : input.personId!;
    try {
      const stored = writeFact({
        workspaceId: input.workspaceId,
        channelId: input.channelId ?? null,
        scopeKind,
        scopeKey,
        subject: fact.subject,
        kind: fact.kind,
        slug: fact.slug,
        body: fact.body,
        ...(fact.confidence ? { confidence: fact.confidence } : {}),
        ...(fact.validFrom ? { validFrom: fact.validFrom } : {}),
        sourceSessionId: input.sessionId,
        sourceMessageId: input.messageId ?? null,
        unreviewed: true,
      });
      recordLineage({
        factId: stored.id,
        sessionId: input.sessionId,
        messageId: input.messageId ?? null,
        actor: input.actor ?? null,
      });
      written += 1;
    } catch (error) {
      logTrace("memory.write_failed", { error: truncate(String(error), 200) }, "warn");
    }
  }
  logTrace("memory.extracted", { sessionId: input.sessionId, written });
  return written;
}
