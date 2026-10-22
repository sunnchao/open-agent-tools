import { Button } from "antd";
import type { ColumnsType } from "antd/es/table";
import { IM_PLATFORM_LABELS } from "../im/api.js";

const CHAT_TYPE_LABELS: Record<string, string> = {
  p2p: "单聊",
  single: "单聊",
  private: "单聊",
  group: "群聊",
  unknown: "未知",
};

const STATUS_LABELS: Record<string, string> = {
  ok: "成功",
  succeeded: "成功",
  success: "成功",
  error: "失败",
  failed: "失败",
  timeout: "超时",
  cancelled: "已取消",
  canceled: "已取消",
  pending: "待处理",
  running: "进行中",
  unknown: "未知",
};

export function chatTypeLabel(value: string): string {
  return CHAT_TYPE_LABELS[value.toLowerCase()] ?? value;
}

export function statusLabel(value: string): string {
  return STATUS_LABELS[value.toLowerCase()] ?? value;
}

export function statusColor(value: string): string {
  const key = value.toLowerCase();
  if (["ok", "succeeded", "success"].includes(key)) return "success";
  if (["error", "failed"].includes(key)) return "error";
  if (["timeout", "cancelled", "canceled"].includes(key)) return "warning";
  return "default";
}

export function platformLabel(platform: string): string {
  return IM_PLATFORM_LABELS[platform as keyof typeof IM_PLATFORM_LABELS] ?? platform;
}

export function formatTime(value: string): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

export function detailColumn<T extends { id: string }>(
  onViewDetails: (record: T) => void,
): ColumnsType<T>[number] {
  return {
    title: "操作",
    key: "details",
    width: 80,
    fixed: "right",
    render: (_: unknown, record: T) => (
      <Button
        type="link"
        size="small"
        disabled={!record.id}
        onClick={(event) => {
          event.stopPropagation();
          onViewDetails(record);
        }}
      >
        详情
      </Button>
    ),
  };
}
