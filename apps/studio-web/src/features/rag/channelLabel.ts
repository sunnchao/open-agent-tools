import type { RetrievalChannel } from "./api.js";

/** 通道标签的展示结果：label 面向用户，color 直接交给 AntD Tag。 */
export interface ChannelLabel {
  label: string;
  color: string;
}

/**
 * 通道组合 → 中文标签。
 *
 * 后端 `channels` 是数组，顺序不保证（并行两路/三路谁先命中不确定），
 * 所以先归一化为「向量 → 关键词 → 图谱」的固定顺序再查表，
 * 避免同一组合因顺序不同显示成两个标签。
 */
const CHANNEL_ORDER: readonly RetrievalChannel[] = ["vector", "keyword", "graph"];

const CHANNEL_LABELS: Record<string, ChannelLabel> = {
  vector: { label: "仅向量", color: "blue" },
  keyword: { label: "仅关键词", color: "green" },
  graph: { label: "仅图谱", color: "volcano" },
  "vector,keyword": { label: "双路命中", color: "purple" },
  "vector,graph": { label: "向量+图谱", color: "cyan" },
  "keyword,graph": { label: "关键词+图谱", color: "orange" },
  "vector,keyword,graph": { label: "三路命中", color: "gold" },
};

/** 归一化通道数组：去重 + 固定顺序，保证标签稳定可测。 */
export function normalizeChannels(channels: readonly string[]): RetrievalChannel[] {
  const present = new Set(channels);
  return CHANNEL_ORDER.filter((channel) => present.has(channel));
}

/**
 * 把一次命中的通道组合映射为标签。
 * 老服务端可能没有 debug.channels（空数组），此时退回 «RRF» 而不是硬猜来源。
 */
export function channelLabel(channels: readonly string[]): ChannelLabel {
  const normalized = normalizeChannels(channels);
  if (normalized.length === 0) return { label: "RRF", color: "default" };
  return CHANNEL_LABELS[normalized.join(",")] ?? { label: "RRF", color: "default" };
}
