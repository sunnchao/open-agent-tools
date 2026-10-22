import { WORKSPACES, type WorkspaceTab } from "../lib/types";

const TAB_IDS = new Set<string>(WORKSPACES.map((item) => item.id));

/**
 * 归一化工作区标识。
 * 旧版本的「图谱」工作区已并入知识库：历史持久化值或旧路由传入 "graph" 时
 * 统一降级到 "rag"，避免渲染分支缺失导致白屏；未知值回落到默认工作流。
 */
export function normalizeTab(value: unknown): WorkspaceTab {
  if (value === "graph") return "rag";
  if (typeof value === "string" && TAB_IDS.has(value)) return value as WorkspaceTab;
  return "workflow";
}

export function initialTab(): WorkspaceTab {
  return "workflow";
}
