import {
  createCaliberResolver,
  type DraftSlots,
  type ResolveContext,
  type ResolveOutcome,
} from "@open-agent-tools/query-resolver";
import {
  getCaliberConfig,
  getDefaultCaliberConfig,
  type CaliberConfigRecord,
} from "./store.js";

export interface CaliberResolverBundle {
  record: CaliberConfigRecord;
  resolve: (
    utterance: string,
    partial?: DraftSlots,
    ctx?: Partial<ResolveContext>,
  ) => Promise<ResolveOutcome>;
}

function resolveRecord(configId?: string): CaliberConfigRecord {
  const record = configId
    ? getCaliberConfig(configId)
    : getDefaultCaliberConfig({ requireEnabled: true });
  if (!record) {
    throw new Error(
      configId ? "caliber config not found" : "no enabled default caliber config configured",
    );
  }
  if (!record.enabled) throw new Error("caliber config is disabled");
  return record;
}

/**
 * 载入指定（或默认）口径配置并编译为解析器；
 * 配置在创建期编译正则，非法配置会在此抛出，路由层转 400。
 */
export function loadCaliberResolver(configId?: string): CaliberResolverBundle {
  const record = resolveRecord(configId);
  return { record, resolve: createCaliberResolver(record.config) };
}

/** 对单条 utterance 执行四类槽位解析，供 DTMS 风格的查询前置使用。 */
export async function resolveCaliberQuery(input: {
  configId?: string;
  utterance: string;
  partial?: DraftSlots;
  ctx?: Partial<ResolveContext>;
}): Promise<{ configId: string; configName: string; outcome: ResolveOutcome }> {
  const { record, resolve } = loadCaliberResolver(input.configId);
  const outcome = await resolve(input.utterance, input.partial, input.ctx);
  return { configId: record.id, configName: record.name, outcome };
}
