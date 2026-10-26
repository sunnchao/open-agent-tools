import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { trimmedString } from "@open-agent-tools/api-contracts/values";
import { DEFAULT_WORKSPACE_ID, openDb } from "../db.js";

export { DEFAULT_WORKSPACE_ID };

/** 前端通过该请求头声明当前 workspace；缺省或非法时回落到默认空间。 */
export const WORKSPACE_HEADER = "x-workspace-id";

export interface Workspace {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

interface WorkspaceRow {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listWorkspaces(): Workspace[] {
  const rows = openDb()
    .prepare(
      `SELECT id, name, description, created_at, updated_at
       FROM workspaces
       ORDER BY (id = ?) DESC, created_at ASC`,
    )
    .all(DEFAULT_WORKSPACE_ID) as unknown as WorkspaceRow[];
  return rows.map(toWorkspace);
}

export function getWorkspace(id: string): Workspace | null {
  const row = openDb()
    .prepare(`SELECT id, name, description, created_at, updated_at FROM workspaces WHERE id = ?`)
    .get(id) as unknown as WorkspaceRow | undefined;
  return row ? toWorkspace(row) : null;
}

export function workspaceExists(id: string): boolean {
  const row = openDb().prepare(`SELECT 1 AS ok FROM workspaces WHERE id = ?`).get(id);
  return Boolean(row);
}

export function createWorkspace(input: { name: string; description?: string }): Workspace {
  const name = input.name.trim();
  if (!name) throw new TypeError("workspace name is required");
  const now = new Date().toISOString();
  const workspace: Workspace = {
    id: randomUUID(),
    name: name.slice(0, 120),
    description: (input.description ?? "").trim().slice(0, 500),
    createdAt: now,
    updatedAt: now,
  };
  openDb()
    .prepare(
      `INSERT INTO workspaces (id, name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(workspace.id, workspace.name, workspace.description, now, now);
  return workspace;
}

export type WorkspaceResolution =
  { ok: true; workspaceId: string } | { ok: false; requested: string };

/**
 * 解析请求所属 workspace。
 *
 * - 未声明 → 默认空间；
 * - 声明了但空间不存在 → 返回 `ok: false`，由调用方回 400。
 *   不静默回落，避免把 A 空间的数据悄悄写进 B 空间。
 *
 * 注意：这里只做归属解析，不做权限校验——鉴权仍是部署级 token。
 */
export function resolveWorkspace(req: Request): WorkspaceResolution {
  const requested = trimmedString(req.header(WORKSPACE_HEADER));
  if (!requested) return { ok: true, workspaceId: DEFAULT_WORKSPACE_ID };
  if (workspaceExists(requested)) return { ok: true, workspaceId: requested };
  return { ok: false, requested };
}
