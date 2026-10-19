import type { Clarification, ClarificationCandidate, ClarificationSlot } from "./types.js";

export interface ClarificationContext {
  originalQuestion?: string;
  round?: number;
  askedSlots?: string[];
}

export interface ClarificationBuildInput {
  question: string;
  clarifying: string;
  context?: ClarificationContext;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface ClarificationBuildResult {
  clarification: Clarification;
  slot: ClarificationSlot;
  repeated: boolean;
}

const SLOT_LABELS: Record<string, string> = {
  row_limit: "返回条数",
  time_range: "时间范围",
  organization: "组织范围",
  metric: "统计口径",
  general: "补充信息",
};

const ROW_LIMIT_CANDIDATES: ClarificationCandidate[] = [
  { label: "最近 10 条", value: "10", description: "返回最近 10 条记录" },
  { label: "最近 50 条", value: "50", description: "返回最近 50 条记录" },
  { label: "最多 100 条", value: "100", description: "返回最多 100 条记录" },
  { label: "全部", value: "全部", description: "查询全部结果，展示仍受安全上限约束" },
];

const TIME_CANDIDATES: ClarificationCandidate[] = [
  { label: "本月", value: "本月" },
  { label: "上个月", value: "上个月" },
  { label: "最近 30 天", value: "最近30天" },
];

/** 从追问文本推断槽位；仅用于统一协议，不替代业务解析器。 */
export function clarificationSlotForPrompt(prompt: string): string {
  if (/(多少条|几条|条数|返回.*?(?:行|条)|行数|limit|top\s*\d+)/i.test(prompt)) return "row_limit";
  if (/(时间|日期|周期|范围|几月|哪年|period|date)/i.test(prompt)) return "time_range";
  if (/(组织|公司|分公司|部门|机构|org)/i.test(prompt)) return "organization";
  if (/(指标|口径|字段|维度|metric)/i.test(prompt)) return "metric";
  return "general";
}

function candidatesFor(slot: string): ClarificationCandidate[] {
  if (slot === "row_limit") return ROW_LIMIT_CANDIDATES.map((item) => ({ ...item }));
  if (slot === "time_range") return TIME_CANDIDATES.map((item) => ({ ...item }));
  return [];
}

function askedFromHistory(
  history: Array<{ role: "user" | "assistant"; content: string }> | undefined,
): string[] {
  if (!history?.length) return [];
  return history
    .filter((turn) => turn.role === "assistant")
    .flatMap((turn) => {
      try {
        const parsed = JSON.parse(
          turn.content.slice(turn.content.indexOf("{"), turn.content.lastIndexOf("}") + 1),
        ) as { clarification?: { missingSlots?: unknown } };
        if (Array.isArray(parsed.clarification?.missingSlots)) {
          return parsed.clarification.missingSlots.filter(
            (slot): slot is string => typeof slot === "string",
          );
        }
      } catch {
        // Legacy assistant turns are plain clarification text.
      }
      return [];
    })
    .concat(
      history
        .filter((turn) => turn.role === "assistant")
        .map((turn) => clarificationSlotForPrompt(turn.content)),
    );
}

/**
 * 生成结构化澄清，并阻止同一槽位在连续轮次中重复追问。
 *
 * `context.askedSlots` 由调用方持久化后回传；旧聊天链路没有该字段时，
 * 从 assistant 历史推断，保证兼容路径也不会无限循环。
 */
export function buildClarification(input: ClarificationBuildInput): ClarificationBuildResult {
  const slotKey = clarificationSlotForPrompt(input.clarifying);
  const candidates = candidatesFor(slotKey);
  const originalQuestion =
    input.context?.originalQuestion?.trim() ||
    input.history?.find((turn) => turn.role === "user")?.content.trim() ||
    input.question.trim();
  const previous = new Set([
    ...(input.context?.askedSlots ?? []),
    ...askedFromHistory(input.history),
  ]);
  const repeated = previous.has(slotKey);
  const slot: ClarificationSlot = {
    key: slotKey,
    label: SLOT_LABELS[slotKey] ?? SLOT_LABELS.general!,
    candidates,
  };
  return {
    repeated,
    slot,
    clarification: {
      slots: [slot],
      candidates,
      originalQuestion,
      round: Math.max(0, input.context?.round ?? 0) + 1,
      missingSlots: repeated ? [] : [slotKey],
      canProceed: false,
      clarifying: input.clarifying.trim(),
    },
  };
}
