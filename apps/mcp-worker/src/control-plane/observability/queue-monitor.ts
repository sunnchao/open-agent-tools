/**
 * 队列积压监控：把 BullMQ 的 getJobCounts 结果归一化为稳定结构，
 * 并按阈值给出健康度标签，供统一 Dashboard / 告警消费。
 */

export interface QueueCounts {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
}

export type QueueHealth = "idle" | "busy" | "backlogged" | "stalled";

export interface QueueSnapshot extends QueueCounts {
  /** 未开始处理的积压 = waiting + delayed + paused。 */
  backlog: number;
  /** 全部状态计数之和。 */
  total: number;
  health: QueueHealth;
}

export interface QueueThresholds {
  /** 超过该积压量判为 backlogged。 */
  backlogWarning: number;
  /** 超过该积压量判为 stalled（严重积压）。 */
  backlogCritical: number;
}

export const DEFAULT_QUEUE_THRESHOLDS: QueueThresholds = {
  backlogWarning: 20,
  backlogCritical: 100,
};

/** 队列不可用时的占位快照，避免调用方到处判空。 */
export const EMPTY_QUEUE_SNAPSHOT: QueueSnapshot = Object.freeze({
  waiting: 0,
  active: 0,
  completed: 0,
  failed: 0,
  delayed: 0,
  paused: 0,
  backlog: 0,
  total: 0,
  health: "idle",
});

/** 队列统计提供方：BullMQ Queue.getJobCounts() 或测试注入的假实现。 */
export interface QueueStatsProvider {
  getJobCounts(): Promise<Record<string, number>>;
}

function toCount(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0;
}

/** 归一化原始计数：缺失状态补 0，忽略负数与非数字。 */
export function normalizeQueueCounts(raw: Record<string, number> | null | undefined): QueueCounts {
  const source = raw ?? {};
  return {
    waiting: toCount(source.waiting),
    active: toCount(source.active),
    completed: toCount(source.completed),
    failed: toCount(source.failed),
    delayed: toCount(source.delayed),
    paused: toCount(source.paused),
  };
}

export function buildQueueSnapshot(
  raw: Record<string, number> | null | undefined,
  thresholds: QueueThresholds = DEFAULT_QUEUE_THRESHOLDS,
): QueueSnapshot {
  const counts = normalizeQueueCounts(raw);
  const backlog = counts.waiting + counts.delayed + counts.paused;
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  let health: QueueHealth;
  if (backlog >= thresholds.backlogCritical) health = "stalled";
  else if (backlog >= thresholds.backlogWarning) health = "backlogged";
  else if (counts.active > 0 || backlog > 0) health = "busy";
  else health = "idle";
  return { ...counts, backlog, total, health };
}

export class QueueMonitor {
  readonly #provider: QueueStatsProvider;
  readonly #thresholds: QueueThresholds;

  constructor(provider: QueueStatsProvider, thresholds: QueueThresholds = DEFAULT_QUEUE_THRESHOLDS) {
    this.#provider = provider;
    this.#thresholds = thresholds;
  }

  async snapshot(): Promise<QueueSnapshot> {
    const counts = await this.#provider.getJobCounts();
    return buildQueueSnapshot(counts, this.#thresholds);
  }
}
