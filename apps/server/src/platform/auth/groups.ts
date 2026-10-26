/**
 * 分组列表归一化：配置写入与管理侧宽松，外部断言校验严格。
 *
 * 两处调用方的语义**有意不同**，不能合并成单一行为：
 * - 宽松（发布应用配置）：非法项跳过，其余保留，最多 50 项；
 * - 严格（viewer assertion）：任一非法项即整体作废，返回 null。
 *
 * 共同的约束：去空白、长度 ≤ 60、禁止 `*`（管理侧全量语义，绝不接受外部输入）、去重。
 */
const MAX_GROUPS = 50;
const MAX_GROUP_LENGTH = 60;

export interface NormalizeGroupsOptions {
  /** true 时任何非法项都返回 null；false 时跳过非法项。 */
  strict: boolean;
}

export function normalizeGroupList(
  value: unknown,
  options: NormalizeGroupsOptions,
): string[] | null {
  const { strict } = options;
  if (!Array.isArray(value)) return strict ? null : [];
  // 严格模式按原始数组长度判定，宽松模式按已接受数量截断。
  if (strict && value.length > MAX_GROUPS) return null;

  const groups: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      if (strict) return null;
      continue;
    }
    const group = item.trim();
    if (!group || group.length > MAX_GROUP_LENGTH || group === "*") {
      if (strict) return null;
      continue;
    }
    if (groups.includes(group)) continue;
    groups.push(group);
    if (groups.length >= MAX_GROUPS) break;
  }
  return groups;
}
