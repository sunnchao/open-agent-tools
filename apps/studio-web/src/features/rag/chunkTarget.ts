/**
 * A4 引用定位:跨工作区导航。
 * 引用点击发生在「对话」工作区,而分块展示发生在「知识库」工作区,两者不会同时挂载,
 * 所以用一个模块级待办 + 订阅来传递目标,避免「先派发事件、后挂载监听」的竞态。
 */

export interface ChunkTarget {
  source: string;
  chunkIndex: number;
}

let pending: ChunkTarget | null = null;
const subscribers = new Set<(target: ChunkTarget) => void>();

/** 记录一个待打开的分块目标,并通知已挂载的知识库工作区。 */
export function requestOpenChunk(target: ChunkTarget): void {
  pending = target;
  for (const notify of subscribers) notify(target);
}

/** 取出并清空待打开的目标,用于组件首次挂载时补取。 */
export function consumePendingChunkTarget(): ChunkTarget | null {
  const target = pending;
  pending = null;
  return target;
}

/**
 * 订阅目标变化。若订阅时已有待办(用户先点了引用、知识库随后才挂载),
 * 立即回调一次,保证不会丢事件。返回取消订阅函数。
 */
export function subscribeChunkTarget(handler: (target: ChunkTarget) => void): () => void {
  subscribers.add(handler);
  const queued = consumePendingChunkTarget();
  if (queued) handler(queued);
  return () => {
    subscribers.delete(handler);
  };
}
