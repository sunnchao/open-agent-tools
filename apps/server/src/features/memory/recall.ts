/**
 * 召回与注入：把已审核事实拼成有界上下文段。
 *
 * 与 CLI 的 `buildMemoryContext` 同构：常驻 pinned（已审核偏好）+ 关键词检索，
 * 带来源引用与“以当前指令为准”的冲突声明。超预算逐条跳过而非整体截断，
 * 保证注入的每条都完整可读。
 */
import { searchFacts, listFacts, type MemoryFact } from "./store.js";

export interface MemoryContextOptions {
  workspaceId: string;
  /** person 作用域；缺省（如 Web 会话）只注入 group 之外的个人事实。 */
  personId?: string;
  query: string;
  /** 常驻偏好条数上限。 */
  pinnedLimit?: number;
  /** 检索命中条数上限。 */
  limit?: number;
  /** 整段字符上限。 */
  maxChars?: number;
}

function formatFact(fact: MemoryFact): string {
  const source = fact.sourceSessionId
    ? `（来源：${fact.sourceSessionId}${fact.sourceMessageId ? `#${fact.sourceMessageId}` : ""}）`
    : "";
  return `- [${fact.scopeKind}/${fact.kind}] ${fact.subject} · ${fact.slug}：${fact.body}${source}`;
}

/**
 * 组装注入段。无命中返回空串，调用方据此不加任何提示词。
 * 明确声明：记忆是参考，与当前指令/文件冲突时以当前为准。
 */
export function buildMemoryContext(options: MemoryContextOptions): string {
  const maxChars = options.maxChars ?? 2_000;
  const header = [
    "## 相关长期记忆（自动召回）",
    "以下为已审核记忆，仅作参考；若与用户当前指令或真实数据冲突，以当前为准。",
  ];
  const lines: string[] = [];
  const seen = new Set<string>();
  let used = header.join("\n").length;

  const pinned = options.personId
    ? listFacts({
        workspaceId: options.workspaceId,
        scopeKind: "person",
        scopeKey: options.personId,
        limit: options.pinnedLimit ?? 5,
      }).filter((fact) => fact.kind === "preference" || fact.kind === "constraint")
    : [];
  const searched = searchFacts(options.query, {
    workspaceId: options.workspaceId,
    ...(options.personId ? { scopeKey: options.personId } : {}),
    limit: options.limit ?? 8,
  });

  for (const fact of [...pinned, ...searched]) {
    if (seen.has(fact.id)) continue;
    const line = formatFact(fact);
    if (used + line.length + 1 > maxChars) continue;
    seen.add(fact.id);
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length === 0) return "";
  return [...header, ...lines].join("\n");
}
