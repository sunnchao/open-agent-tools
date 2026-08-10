import type { ResolverResult } from "../types.js";

export interface OrgEntry {
  code: string;
  name: string;
  aliases: string[];
  parent?: string;
}
export type OrgDirectory = OrgEntry[];

export interface OrgValue {
  code: string;
  name: string;
}

/**
 * 组织解析：别名/名称 → org_code。
 * 匹配规则双向：utterance 包含别名，或别名包含 utterance（兼容"北京"命中"北京分公司"）。
 * 命中多个 → ambiguous，交编排器列候选反问；命中 0 个 → missing。
 */
export function resolveOrg(raw: string | undefined, dir: OrgDirectory): ResolverResult<OrgValue> {
  if (!raw) {
    return { value: null, candidates: [], ambiguous: false, missing: true, note: "未提供组织" };
  }

  const hits = dir.filter(
    (e) =>
      e.aliases.some((a) => raw.includes(a) || a.includes(raw)) ||
      raw.includes(e.name) ||
      e.name.includes(raw),
  );

  if (hits.length === 0) {
    return { value: null, candidates: [], ambiguous: false, missing: true, note: `组织未匹配: ${raw}` };
  }

  if (hits.length === 1) {
    const e = hits[0]!;
    const value: OrgValue = { code: e.code, name: e.name };
    return {
      value,
      candidates: [{ label: e.name, value, score: 1 }],
      ambiguous: false,
      missing: false,
      note: `别名命中: ${raw}`,
    };
  }

  const candidates = hits.map((e) => {
    const v: OrgValue = { code: e.code, name: e.name };
    return { label: e.name, value: v, score: 1 };
  });
  return { value: null, candidates, ambiguous: true, missing: false, note: `多个候选: ${raw}` };
}
