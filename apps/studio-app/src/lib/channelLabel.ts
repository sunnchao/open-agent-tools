import type { RetrievalChannel } from "../api/rag";

/** 通道展示顺序：向量 → 关键词 → 图谱。 */
const CHANNEL_ORDER: RetrievalChannel[] = ["vector", "keyword", "graph"];

/** 通道 → 展示标签与 MD3 主题色名（与 Paper 主题色板对应）。 */
const CHANNEL_META: Record<
  RetrievalChannel,
  { label: string; color: "primary" | "secondary" | "tertiary" }
> = {
  vector: { label: "向量", color: "primary" },
  keyword: { label: "关键词", color: "secondary" },
  graph: { label: "图谱", color: "tertiary" },
};

export interface ChannelTag {
  channel: RetrievalChannel;
  label: string;
  color: "primary" | "secondary" | "tertiary";
}

/**
 * 把后端返回的 channels 归一化为去重、固定顺序的通道标签。
 * 旧服务端可能返回空数组或未知值，这里统一忽略，避免 RN 列表渲染出脏 tag。
 */
export function channelLabels(channels: readonly string[] | undefined): ChannelTag[] {
  if (!channels || channels.length === 0) return [];
  const present = new Set(channels);
  return CHANNEL_ORDER.filter((channel) => present.has(channel)).map((channel) => ({
    channel,
    ...CHANNEL_META[channel],
  }));
}

/** 单行通道摘要（如「向量+图谱」），无 channel 时返回空字符串。 */
export function channelSummary(channels: readonly string[] | undefined): string {
  return channelLabels(channels)
    .map((tag) => tag.label)
    .join("+");
}
