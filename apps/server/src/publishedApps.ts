import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { openDb } from "./db.js";
import type { McpToolBinding } from "./resources.js";

export interface PublishedAppResources {
  rag?: { sources?: string[]; topK?: number };
  mcpTools?: McpToolBinding[];
  sqlSources?: string[];
}

export interface PublishedAppSuggestion {
  title: string;
  prompt: string;
}

export type PublishedAppAccessMode = "public" | "token";

export interface PublishedApp {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: string;
  welcome: string;
  suggestions: PublishedAppSuggestion[];
  resources: PublishedAppResources;
  /**
   * 允许查看该应用的调用方分组。空数组表示只允许公开文档和公开应用，
   * 不表示绕过文档 ACL。组名同时用于文档 ACL 的 viewerGroups，不引入用户体系。
   */
  allowedGroups: string[];
  providerId: string | null;
  model: string | null;
  status: "ACTIVE" | "ARCHIVED";
  /** public：拿到链接即可用；token：需携带访问口令（分享链接即凭证）。 */
  accessMode: PublishedAppAccessMode;
  /** 访问口令掩码（仅用于管理界面回显，明文只在创建/轮换时返回一次）。 */
  accessTokenHint: string | null;
  /** 每分钟请求上限；0 表示不限。 */
  rateLimitPerMinute: number;
  /** 每日 token 预算；0 表示不限。 */
  dailyTokenBudget: number;
  createdAt: string;
  updatedAt: string;
}

export interface PublishedAppInput {
  name: string;
  slug?: string;
  description?: string;
  welcome?: string;
  suggestions?: PublishedAppSuggestion[];
  resources?: PublishedAppResources;
  allowedGroups?: string[];
  providerId?: string | null;
  model?: string | null;
  status?: "ACTIVE" | "ARCHIVED";
  accessMode?: PublishedAppAccessMode;
  rateLimitPerMinute?: number;
  dailyTokenBudget?: number;
}

interface PublishedAppRow {
  id: string;
  workspace_id: string;
  slug: string;
  name: string;
  description: string;
  welcome: string;
  suggestions_json: string;
  resources_json: string;
  allowed_groups_json: string | null;
  provider_id: string | null;
  model: string | null;
  status: string;
  access_mode: string | null;
  access_token_hash: string | null;
  access_token_hint: string | null;
  rate_limit_per_minute: number | null;
  daily_token_budget: number | null;
  created_at: string;
  updated_at: string;
}

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** 由名称派生 slug：保留 ASCII 字母数字，中文等直接丢弃后回退随机串。 */
export function deriveSlug(name: string): string {
  const ascii = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return ascii || `app-${randomUUID().slice(0, 8)}`;
}

export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function toApp(row: PublishedAppRow): PublishedApp {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    welcome: row.welcome,
    suggestions: parseJson<PublishedAppSuggestion[]>(row.suggestions_json, []),
    resources: parseJson<PublishedAppResources>(row.resources_json, {}),
    allowedGroups: parseJson<string[]>(row.allowed_groups_json ?? "[]", []).filter(
      (group): group is string => typeof group === "string",
    ),
    providerId: row.provider_id,
    model: row.model,
    status: row.status === "ARCHIVED" ? "ARCHIVED" : "ACTIVE",
    accessMode: row.access_mode === "token" ? "token" : "public",
    accessTokenHint: row.access_token_hint,
    rateLimitPerMinute: row.rate_limit_per_minute ?? 20,
    dailyTokenBudget: row.daily_token_budget ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listPublishedApps(workspaceId?: string): PublishedApp[] {
  const rows = openDb()
    .prepare(
      `SELECT * FROM published_apps
       ${workspaceId ? "WHERE workspace_id = ?" : ""}
       ORDER BY created_at DESC`,
    )
    .all(...(workspaceId ? [workspaceId] : [])) as unknown as PublishedAppRow[];
  return rows.map(toApp);
}

/** 按 slug 取发布应用——终端用户入口只认 slug，不暴露内部 id。 */
export function getPublishedAppBySlug(slug: string): PublishedApp | null {
  const row = openDb()
    .prepare(`SELECT * FROM published_apps WHERE slug = ?`)
    .get(slug) as unknown as PublishedAppRow | undefined;
  return row ? toApp(row) : null;
}

export function getPublishedApp(id: string): PublishedApp | null {
  const row = openDb().prepare(`SELECT * FROM published_apps WHERE id = ?`).get(id) as unknown as
    PublishedAppRow | undefined;
  return row ? toApp(row) : null;
}

export function createPublishedApp(workspaceId: string, input: PublishedAppInput): PublishedApp {
  const name = input.name.trim();
  if (!name) throw new TypeError("app name is required");
  const slug = (input.slug?.trim() || deriveSlug(name)).toLowerCase();
  if (!isValidSlug(slug)) {
    throw new TypeError("slug must be 1-64 chars of lowercase letters, digits or hyphens");
  }
  if (getPublishedAppBySlug(slug)) throw new TypeError(`slug already exists: ${slug}`);

  const now = new Date().toISOString();
  const app: PublishedApp = {
    id: randomUUID(),
    workspaceId,
    slug,
    name: name.slice(0, 120),
    description: (input.description ?? "").trim().slice(0, 500),
    welcome: (input.welcome ?? "").trim().slice(0, 500),
    suggestions: (input.suggestions ?? []).slice(0, 8),
    resources: input.resources ?? {},
    allowedGroups: normalizeGroups(input.allowedGroups),
    providerId: input.providerId ?? null,
    model: input.model ?? null,
    status: input.status ?? "ACTIVE",
    accessMode: input.accessMode === "token" ? "token" : "public",
    accessTokenHint: null,
    rateLimitPerMinute: clampLimit(input.rateLimitPerMinute, 20, 0, 600),
    dailyTokenBudget: clampLimit(input.dailyTokenBudget, 0, 0, 100_000_000),
    createdAt: now,
    updatedAt: now,
  };
  openDb()
    .prepare(
      `INSERT INTO published_apps (
         id, workspace_id, slug, name, description, welcome, suggestions_json,
         resources_json, allowed_groups_json, provider_id, model, status, access_mode,
         access_token_hash, access_token_hint, rate_limit_per_minute, daily_token_budget,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
    )
    .run(
      app.id,
      app.workspaceId,
      app.slug,
      app.name,
      app.description,
      app.welcome,
      JSON.stringify(app.suggestions),
      JSON.stringify(app.resources),
      JSON.stringify(app.allowedGroups),
      app.providerId,
      app.model,
      app.status,
      app.accessMode,
      app.rateLimitPerMinute,
      app.dailyTokenBudget,
      now,
      now,
    );
  return app;
}

function clampLimit(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function updatePublishedApp(
  id: string,
  patch: Partial<PublishedAppInput>,
): PublishedApp | null {
  const current = getPublishedApp(id);
  if (!current) return null;
  const nextSlug = patch.slug?.trim().toLowerCase() ?? current.slug;
  if (!isValidSlug(nextSlug)) {
    throw new TypeError("slug must be 1-64 chars of lowercase letters, digits or hyphens");
  }
  if (nextSlug !== current.slug && getPublishedAppBySlug(nextSlug)) {
    throw new TypeError(`slug already exists: ${nextSlug}`);
  }
  const now = new Date().toISOString();
  openDb()
    .prepare(
      `UPDATE published_apps SET
         slug = ?, name = ?, description = ?, welcome = ?, suggestions_json = ?,
         resources_json = ?, allowed_groups_json = ?, provider_id = ?, model = ?, status = ?,
         access_mode = ?, rate_limit_per_minute = ?, daily_token_budget = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      nextSlug,
      (patch.name ?? current.name).trim().slice(0, 120),
      (patch.description ?? current.description).trim().slice(0, 500),
      (patch.welcome ?? current.welcome).trim().slice(0, 500),
      JSON.stringify(patch.suggestions ?? current.suggestions),
      JSON.stringify(patch.resources ?? current.resources),
      JSON.stringify(
        patch.allowedGroups === undefined
          ? current.allowedGroups
          : normalizeGroups(patch.allowedGroups),
      ),
      patch.providerId === undefined ? current.providerId : patch.providerId,
      patch.model === undefined ? current.model : patch.model,
      patch.status ?? current.status,
      patch.accessMode ?? current.accessMode,
      patch.rateLimitPerMinute === undefined
        ? current.rateLimitPerMinute
        : clampLimit(patch.rateLimitPerMinute, 20, 0, 600),
      patch.dailyTokenBudget === undefined
        ? current.dailyTokenBudget
        : clampLimit(patch.dailyTokenBudget, 0, 0, 100_000_000),
      now,
      id,
    );
  return getPublishedApp(id);
}

/**
 * 分组名去重、去空、限长；最多 50 个。空数组只允许公开文档。
 * "*" 是管理侧内部的全量语义，绝不能从发布应用配置或外部断言进入。
 */
export function normalizeGroups(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const groups: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const group = item.trim();
    if (!group || group.length > 60 || group === "*" || groups.includes(group)) continue;
    groups.push(group);
    if (groups.length >= 50) break;
  }
  return groups;
}

/* ---------------- 访问口令 ---------------- */

/** 访问口令的存储格式：只存哈希，明文仅在生成时返回一次。 */
export function hashAccessToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateAccessToken(): { token: string; hint: string; hash: string } {
  const token = randomBytes(24).toString("base64url");
  return {
    token,
    // 回显掩码：够管理员辨认是哪一条，又不泄露完整口令。
    hint: `${token.slice(0, 6)}…${token.slice(-4)}`,
    hash: hashAccessToken(token),
  };
}

/**
 * 设置访问口令。传 null 表示撤销（回到 public 模式）。
 * 返回明文口令，调用方需一次性返回给管理员——之后再也取不到。
 */
export function rotateAccessToken(id: string, enable: boolean): string | null {
  const app = getPublishedApp(id);
  if (!app) return null;
  if (!enable) {
    openDb()
      .prepare(
        `UPDATE published_apps SET access_mode = 'public', access_token_hash = NULL,
           access_token_hint = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(new Date().toISOString(), id);
    return null;
  }
  const { token, hint, hash } = generateAccessToken();
  openDb()
    .prepare(
      `UPDATE published_apps SET access_mode = 'token', access_token_hash = ?,
         access_token_hint = ?, updated_at = ? WHERE id = ?`,
    )
    .run(hash, hint, new Date().toISOString(), id);
  return token;
}

/** 校验访问口令：public 模式恒通过；token 模式必须匹配哈希。 */
export function verifyAppAccess(app: PublishedApp, token: string | null): boolean {
  if (app.accessMode === "public") return true;
  if (!token) return false;
  const row = openDb()
    .prepare(`SELECT access_token_hash AS hash FROM published_apps WHERE id = ?`)
    .get(app.id) as { hash: string | null } | undefined;
  if (!row?.hash) return false;
  return timingSafeEqual(Buffer.from(hashAccessToken(token), "hex"), Buffer.from(row.hash, "hex"));
}

export function deletePublishedApp(id: string): boolean {
  const result = openDb().prepare(`DELETE FROM published_apps WHERE id = ?`).run(id);
  return result.changes > 0;
}
