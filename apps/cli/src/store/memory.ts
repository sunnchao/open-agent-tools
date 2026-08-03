import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const MEMORY_TYPES = ["user", "feedback", "project", "reference", "daily"] as const;
export const MEMORY_SCOPES = ["global", "project"] as const;
export const MEMORY_CONFIDENCES = ["high", "medium", "low", "unknown"] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];
export type MemoryScope = (typeof MEMORY_SCOPES)[number];
export type MemoryConfidence = (typeof MEMORY_CONFIDENCES)[number];
export type MemoryActor = "user" | "tool" | "extractor";

export interface MemorySource {
  actor: MemoryActor;
  conversationId?: string;
  model?: string;
}

export interface MemoryWriteInput {
  slug: string;
  scope: MemoryScope;
  type: MemoryType;
  description: string;
  headline?: string;
  body: string;
  actor?: MemoryActor;
  conversationId?: string;
  model?: string;
  confidence?: MemoryConfidence;
  unreviewed?: boolean;
  links?: string[];
  date?: string;
}

export interface MemoryMeta {
  slug: string;
  scope: MemoryScope;
  type: MemoryType;
  description: string;
  headline: string;
  date?: string;
  createdAt: number;
  updatedAt: number;
  confidence: MemoryConfidence;
  unreviewed: boolean;
  source: MemorySource;
  links: string[];
  archived: boolean;
  filePath: string;
  workdirHash: string;
}

export interface MemoryEntry {
  meta: MemoryMeta;
  body: string;
}

export interface MemorySearchMatch extends MemoryEntry {
  score: number;
  matchedBy: Array<"fts" | "headline" | "description" | "body">;
}

export interface MemoryMutationResult extends MemoryEntry {
  created: boolean;
}

export interface MemoryQuotaItem {
  scope: MemoryScope;
  count: number;
  limit: number;
  exceeded: boolean;
}

export interface MemoryOrganizeSuggestion {
  left: MemoryMeta;
  right: MemoryMeta;
  similarity: number;
}

export interface MemoryStoreOptions {
  cwd?: string;
  globalRoot?: string;
  projectRoot?: string;
  maxScopeEntries?: number;
  dailyMaxBytes?: number;
  rolloverHour?: number;
}

interface ParsedMemory {
  meta: MemoryMeta;
  body: string;
}

interface IndexHandle {
  root: string;
  db: DatabaseSync;
}

interface MetaRow {
  scope: MemoryScope;
  workdirHash: string;
  slug: string;
  type: MemoryType;
  description: string;
  headline: string;
  dateLocal: string | null;
  confidence: MemoryConfidence;
  unreviewed: number;
  archived: number;
  createdAt: number;
  updatedAt: number;
  sourceJson: string | null;
  linksJson: string | null;
  filePath: string;
}

const TYPE_WEIGHT: Record<MemoryType, number> = {
  project: 1.4,
  user: 1.3,
  feedback: 1.25,
  reference: 1,
  daily: 0.35,
};

function defaultGlobalRoot(): string {
  return (
    process.env.AGENT_DEMO_MEMORY_HOME || join(homedir(), ".config", "open-agent-tools", "memory")
  );
}

function stableWorkdirHash(cwd: string): string {
  return createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16);
}

function bodyHash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function normalizeSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 80);
  if (!slug) throw new Error("记忆 slug 不能为空，且必须包含字母、数字、中文、下划线或连字符");
  return slug;
}

function assertType(value: string): asserts value is MemoryType {
  if (!(MEMORY_TYPES as readonly string[]).includes(value))
    throw new Error(`无效记忆类型: ${value}`);
}

function assertScope(value: string): asserts value is MemoryScope {
  if (!(MEMORY_SCOPES as readonly string[]).includes(value))
    throw new Error(`无效记忆作用域: ${value}`);
}

function assertConfidence(value: string): asserts value is MemoryConfidence {
  if (!(MEMORY_CONFIDENCES as readonly string[]).includes(value))
    throw new Error(`无效置信度: ${value}`);
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function scalar(value: unknown): string {
  return JSON.stringify(value);
}

function localDateAt(now: Date, rolloverHour: number): string {
  const shifted = new Date(now.getTime());
  if (shifted.getHours() < rolloverHour) shifted.setDate(shifted.getDate() - 1);
  const year = shifted.getFullYear();
  const month = String(shifted.getMonth() + 1).padStart(2, "0");
  const day = String(shifted.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function renderMemoryMarkdown(meta: MemoryMeta, body: string): string {
  const source = JSON.stringify(meta.source);
  const links = JSON.stringify(meta.links);
  const lines = [
    "---",
    `name: ${scalar(meta.slug)}`,
    `type: ${scalar(meta.type)}`,
    `scope: ${scalar(meta.scope)}`,
    `description: ${scalar(meta.description)}`,
    `headline: ${scalar(meta.headline)}`,
    ...(meta.date ? [`date: ${scalar(meta.date)}`] : []),
    `created_at: ${scalar(new Date(meta.createdAt).toISOString())}`,
    `updated_at: ${scalar(new Date(meta.updatedAt).toISOString())}`,
    `confidence: ${scalar(meta.confidence)}`,
    `unreviewed: ${meta.unreviewed}`,
    `source: ${source}`,
    `links: ${links}`,
    "---",
    "",
    body.trim(),
    "",
  ];
  return lines.join("\n");
}

export function parseMemoryMarkdown(
  filePath: string,
  content: string,
  workdirHash = "",
): ParsedMemory {
  const normalizedContent = content.replace(/\r\n/g, "\n");
  if (!normalizedContent.startsWith("---\n"))
    throw new Error(`记忆文件缺少 frontmatter: ${filePath}`);
  const end = normalizedContent.indexOf("\n---\n", 4);
  if (end < 0) throw new Error(`记忆文件 frontmatter 未闭合: ${filePath}`);

  const values = new Map<string, unknown>();
  for (const line of normalizedContent.slice(4, end).split("\n")) {
    const sep = line.indexOf(":");
    if (sep <= 0) continue;
    values.set(line.slice(0, sep).trim(), parseScalar(line.slice(sep + 1)));
  }

  const slug = normalizeSlug(String(values.get("name") ?? basename(filePath, ".md")));
  const typeValue = String(values.get("type") ?? "project");
  const scopeValue = String(values.get("scope") ?? "project");
  const confidenceValue = String(values.get("confidence") ?? "unknown");
  assertType(typeValue);
  assertScope(scopeValue);
  assertConfidence(confidenceValue);

  const sourceValue = values.get("source");
  const source =
    sourceValue && typeof sourceValue === "object"
      ? (sourceValue as MemorySource)
      : ({ actor: "user" } satisfies MemorySource);
  const linksValue = values.get("links");
  const links = Array.isArray(linksValue)
    ? linksValue.filter((item): item is string => typeof item === "string")
    : [];
  const createdAt =
    Date.parse(String(values.get("created_at") ?? "")) ||
    statSync(filePath).birthtimeMs ||
    Date.now();
  const updatedAt =
    Date.parse(String(values.get("updated_at") ?? "")) || statSync(filePath).mtimeMs || createdAt;
  const body = normalizedContent.slice(end + 5).trim();

  return {
    meta: {
      slug,
      scope: scopeValue,
      type: typeValue,
      description: String(values.get("description") ?? ""),
      headline: String(values.get("headline") ?? values.get("description") ?? slug),
      ...(typeof values.get("date") === "string" ? { date: String(values.get("date")) } : {}),
      createdAt,
      updatedAt,
      confidence: confidenceValue,
      unreviewed: values.get("unreviewed") !== false,
      source,
      links,
      archived: false,
      filePath,
      workdirHash,
    },
    body,
  };
}

function atomicReplace(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, content, "utf8");
  renameSync(tempPath, filePath);
}

function openIndex(root: string): IndexHandle {
  mkdirSync(root, { recursive: true });
  const db = new DatabaseSync(join(root, "memory-index.sqlite"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_meta (
      scope TEXT NOT NULL CHECK (scope IN ('global','project')),
      workdir_hash TEXT NOT NULL DEFAULT '',
      slug TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('user','feedback','project','reference','daily')),
      description TEXT NOT NULL DEFAULT '',
      headline TEXT NOT NULL DEFAULT '',
      date_local TEXT,
      confidence TEXT NOT NULL DEFAULT 'unknown',
      unreviewed INTEGER NOT NULL DEFAULT 1,
      archived INTEGER NOT NULL DEFAULT 0,
      body_hash TEXT NOT NULL,
      file_mtime INTEGER NOT NULL,
      file_size INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source_json TEXT,
      links_json TEXT,
      file_path TEXT NOT NULL,
      PRIMARY KEY (scope, workdir_hash, slug)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      slug UNINDEXED,
      scope UNINDEXED,
      workdir_hash UNINDEXED,
      type,
      description,
      headline,
      body,
      tokenize='trigram'
    );

    CREATE TABLE IF NOT EXISTS memory_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      op TEXT NOT NULL CHECK (op IN ('write','update','delete','accept','wipe','daily_append')),
      scope TEXT NOT NULL,
      workdir_hash TEXT NOT NULL DEFAULT '',
      slug TEXT NOT NULL,
      actor TEXT NOT NULL,
      conversation_id TEXT,
      detail_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_memory_meta_updated ON memory_meta(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_meta_review ON memory_meta(unreviewed, archived);
  `);
  return { root, db };
}

function rowToMeta(row: MetaRow): MemoryMeta {
  let source: MemorySource = { actor: "user" };
  let links: string[] = [];
  try {
    if (row.sourceJson) source = JSON.parse(row.sourceJson) as MemorySource;
  } catch {
    // 保留安全默认值。
  }
  try {
    if (row.linksJson) links = JSON.parse(row.linksJson) as string[];
  } catch {
    // 保留空数组。
  }
  return {
    slug: row.slug,
    scope: row.scope,
    type: row.type,
    description: row.description,
    headline: row.headline,
    ...(row.dateLocal ? { date: row.dateLocal } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    confidence: row.confidence,
    unreviewed: row.unreviewed === 1,
    source,
    links,
    archived: row.archived === 1,
    filePath: row.filePath,
    workdirHash: row.workdirHash,
  };
}

function selectRows(
  handle: IndexHandle,
  where = "1=1",
  params: Array<string | number> = [],
): MetaRow[] {
  return handle.db
    .prepare(
      `SELECT scope, workdir_hash AS workdirHash, slug, type, description, headline,
              date_local AS dateLocal, confidence, unreviewed, archived,
              created_at AS createdAt, updated_at AS updatedAt,
              source_json AS sourceJson, links_json AS linksJson, file_path AS filePath
       FROM memory_meta WHERE ${where}`,
    )
    .all(...params) as unknown as MetaRow[];
}

function queryTerms(query: string): string[] {
  const terms = new Set(query.split(/\s+/).filter((term) => term.length >= 2));
  // 中文无空格分词，连续 CJK 串按二元切分，保证长句也能命中局部关键词。
  for (const match of query.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const value = match[0];
    for (let i = 0; i < value.length - 1; i += 1) terms.add(value.slice(i, i + 2));
  }
  return [...terms];
}

function tokenizeForSimilarity(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ");
  const tokens = new Set(normalized.split(/\s+/).filter((part) => part.length >= 2));
  for (const match of normalized.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const value = match[0];
    for (let i = 0; i < value.length - 1; i += 1) tokens.add(value.slice(i, i + 2));
  }
  return tokens;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

export class MemoryStore {
  readonly cwd: string;
  readonly globalRoot: string;
  readonly projectRoot: string;
  readonly workdirHash: string;
  readonly maxScopeEntries: number;
  readonly dailyMaxBytes: number;
  readonly rolloverHour: number;
  private globalIndex: IndexHandle | null = null;
  private projectIndex: IndexHandle | null = null;

  constructor(options: MemoryStoreOptions = {}) {
    this.cwd = resolve(options.cwd ?? process.cwd());
    this.globalRoot = resolve(options.globalRoot ?? defaultGlobalRoot());
    this.projectRoot = resolve(
      options.projectRoot ?? join(this.cwd, ".open-agent-tools", "memory"),
    );
    this.workdirHash = stableWorkdirHash(this.cwd);
    this.maxScopeEntries = options.maxScopeEntries ?? 500;
    this.dailyMaxBytes = options.dailyMaxBytes ?? 32 * 1024;
    this.rolloverHour = options.rolloverHour ?? 4;
  }

  open(): void {
    if (!this.globalIndex) this.globalIndex = openIndex(this.globalRoot);
    if (!this.projectIndex) this.projectIndex = openIndex(this.projectRoot);
    this.reindex();
  }

  close(): void {
    this.globalIndex?.db.close();
    this.projectIndex?.db.close();
    this.globalIndex = null;
    this.projectIndex = null;
  }

  write(input: MemoryWriteInput): MemoryMutationResult {
    this.ensureOpen();
    const slug = normalizeSlug(input.slug);
    const handle = this.handleForScope(input.scope);
    const existing = this.read(slug, input.scope);
    if (existing && !existing.meta.unreviewed && (input.unreviewed ?? input.actor !== "user")) {
      throw new Error(
        `已存在同名已审核记忆: ${slug}；请使用新的 slug，不能用待审核提议覆盖可信记忆`,
      );
    }
    if (input.type === "daily" && input.date && !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
      throw new Error(`无效 daily 日期: ${input.date}`);
    }
    const now = Date.now();
    const filePath = this.pathFor(input.scope, slug, input.type, input.date);
    const meta: MemoryMeta = {
      slug,
      scope: input.scope,
      type: input.type,
      description: input.description.trim().slice(0, 240),
      headline: (input.headline ?? input.description ?? slug).trim().slice(0, 120),
      ...(input.type === "daily"
        ? { date: input.date ?? localDateAt(new Date(), this.rolloverHour) }
        : {}),
      createdAt: existing?.meta.createdAt ?? now,
      updatedAt: now,
      confidence: input.confidence ?? "unknown",
      unreviewed: input.unreviewed ?? input.actor !== "user",
      source: {
        actor: input.actor ?? "user",
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        ...(input.model ? { model: input.model } : {}),
      },
      links: input.links ?? [],
      archived: false,
      filePath,
      workdirHash: input.scope === "project" ? this.workdirHash : "",
    };
    atomicReplace(filePath, renderMemoryMarkdown(meta, input.body));
    this.indexEntry(handle, { meta, body: input.body.trim() });
    this.audit(
      handle,
      existing ? "update" : "write",
      meta,
      input.actor ?? "user",
      input.conversationId,
    );
    return { meta, body: input.body.trim(), created: !existing };
  }

  accept(slug: string, scope?: MemoryScope): MemoryEntry {
    const entry = this.requireRead(slug, scope);
    if (!entry.meta.unreviewed) return entry;
    const updated = this.write({
      slug: entry.meta.slug,
      scope: entry.meta.scope,
      type: entry.meta.type,
      description: entry.meta.description,
      headline: entry.meta.headline,
      body: entry.body,
      actor: "user",
      confidence: entry.meta.confidence,
      unreviewed: false,
      links: entry.meta.links,
      ...(entry.meta.date ? { date: entry.meta.date } : {}),
    });
    this.audit(this.handleForScope(updated.meta.scope), "accept", updated.meta, "user");
    return updated;
  }

  remove(slug: string, scope?: MemoryScope, reason?: string): boolean {
    const entry = this.read(slug, scope);
    if (!entry) return false;
    const handle = this.handleForScope(entry.meta.scope);
    if (existsSync(entry.meta.filePath)) rmSync(entry.meta.filePath);
    handle.db
      .prepare("DELETE FROM memory_meta WHERE scope = ? AND workdir_hash = ? AND slug = ?")
      .run(entry.meta.scope, entry.meta.workdirHash, entry.meta.slug);
    handle.db
      .prepare("DELETE FROM memory_fts WHERE scope = ? AND workdir_hash = ? AND slug = ?")
      .run(entry.meta.scope, entry.meta.workdirHash, entry.meta.slug);
    this.audit(handle, "delete", entry.meta, "user", undefined, reason ? { reason } : undefined);
    return true;
  }

  list(
    options: {
      scope?: MemoryScope;
      type?: MemoryType;
      limit?: number;
      includeUnreviewed?: boolean;
    } = {},
  ): MemoryMeta[] {
    this.ensureOpen();
    const rows = this.allRelevantRows();
    return rows
      .map(rowToMeta)
      .filter((meta) => !meta.archived)
      .filter((meta) => !options.scope || meta.scope === options.scope)
      .filter((meta) => !options.type || meta.type === options.type)
      .filter((meta) => options.includeUnreviewed !== false || !meta.unreviewed)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, options.limit ?? 100);
  }

  read(slug: string, scope?: MemoryScope): MemoryEntry | null {
    this.ensureOpen();
    const normalized = normalizeSlug(slug);
    const scopes: MemoryScope[] = scope ? [scope] : ["project", "global"];
    for (const candidate of scopes) {
      const handle = this.handleForScope(candidate);
      const hash = candidate === "project" ? this.workdirHash : "";
      const row = selectRows(
        handle,
        "scope = ? AND workdir_hash = ? AND slug = ? AND archived = 0",
        [candidate, hash, normalized],
      )[0];
      if (!row) continue;
      const meta = rowToMeta(row);
      if (!existsSync(meta.filePath)) continue;
      try {
        const parsed = parseMemoryMarkdown(
          meta.filePath,
          readFileSync(meta.filePath, "utf8"),
          meta.workdirHash,
        );
        return { meta: { ...parsed.meta, workdirHash: meta.workdirHash }, body: parsed.body };
      } catch {
        continue;
      }
    }
    return null;
  }

  search(
    query: string,
    options: {
      scope?: MemoryScope;
      type?: MemoryType;
      limit?: number;
      includeUnreviewed?: boolean;
    } = {},
  ): MemorySearchMatch[] {
    this.ensureOpen();
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return [];
    const ftsKeys = new Set<string>();
    if (normalizedQuery.length >= 3) {
      const phrase = `"${normalizedQuery.replace(/"/g, '""')}"`;
      for (const handle of this.handles()) {
        try {
          const rows = handle.db
            .prepare(
              `SELECT scope, workdir_hash AS workdirHash, slug
               FROM memory_fts WHERE memory_fts MATCH ?`,
            )
            .all(phrase) as unknown as Array<{ scope: string; workdirHash: string; slug: string }>;
          for (const row of rows) ftsKeys.add(`${row.scope}:${row.workdirHash}:${row.slug}`);
        } catch {
          // FTS 查询失败时仍由下方 JS 扫描兜底。
        }
      }
    }

    const now = Date.now();
    const fallbackTerms = queryTerms(normalizedQuery);
    const matches: MemorySearchMatch[] = [];
    for (const meta of this.list({
      scope: options.scope,
      type: options.type,
      limit: this.maxScopeEntries * 2,
      includeUnreviewed: options.includeUnreviewed ?? false,
    })) {
      const entry = this.read(meta.slug, meta.scope);
      if (!entry) continue;
      const headline = meta.headline.toLowerCase();
      const description = meta.description.toLowerCase();
      const body = entry.body.toLowerCase();
      const key = `${meta.scope}:${meta.workdirHash}:${meta.slug}`;
      const matchedBy: MemorySearchMatch["matchedBy"] = [];
      let relevance = 0;
      if (ftsKeys.has(key)) {
        matchedBy.push("fts");
        relevance += 1;
      }
      if (headline.includes(normalizedQuery)) {
        matchedBy.push("headline");
        relevance += 2.4;
      }
      if (description.includes(normalizedQuery)) {
        matchedBy.push("description");
        relevance += 1.8;
      }
      if (body.includes(normalizedQuery)) {
        matchedBy.push("body");
        relevance += 1;
      }
      if (relevance === 0) {
        const haystack = `${headline}\n${description}\n${body}`;
        const hitCount = fallbackTerms.filter((term) => haystack.includes(term)).length;
        if (hitCount === 0) continue;
        relevance = hitCount / fallbackTerms.length;
        matchedBy.push("body");
      }
      const ageDays = Math.max(0, (now - meta.updatedAt) / 86_400_000);
      const recency = 1 + 0.2 / (1 + ageDays / 30);
      const scopeBoost = meta.scope === "project" ? 1.12 : 1;
      matches.push({
        ...entry,
        score: relevance * TYPE_WEIGHT[meta.type] * recency * scopeBoost,
        matchedBy,
      });
    }
    return matches.sort((a, b) => b.score - a.score).slice(0, options.limit ?? 8);
  }

  appendDaily(
    bullet: string,
    options: { scope?: MemoryScope; actor?: MemoryActor; conversationId?: string; now?: Date } = {},
  ): MemoryEntry {
    const scope = options.scope ?? "project";
    const actor = options.actor ?? "tool";
    const date = localDateAt(options.now ?? new Date(), this.rolloverHour);
    const slug =
      actor === "user" ? `daily-${date}` : `daily-${date}-proposal-${randomUUID().slice(0, 8)}`;
    const existing = actor === "user" ? this.read(slug, scope) : null;
    const line = bullet.trim().replace(/^[-*]\s*/, "");
    if (!line) throw new Error("daily 内容不能为空");
    const nextBody = existing ? `${existing.body.trim()}\n- ${line}` : `- ${line}`;
    const sizeProbeMeta: MemoryMeta = {
      slug,
      scope,
      type: "daily",
      description: `${date} 工作日志`,
      headline: `${date} 工作日志`,
      date,
      createdAt: existing?.meta.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      confidence: "high",
      unreviewed: actor !== "user",
      source: { actor },
      links: [],
      archived: false,
      filePath: "",
      workdirHash: scope === "project" ? this.workdirHash : "",
    };
    if (
      Buffer.byteLength(renderMemoryMarkdown(sizeProbeMeta, nextBody), "utf8") > this.dailyMaxBytes
    ) {
      throw new Error(`今日日志文件超过 ${this.dailyMaxBytes} 字节上限，请先整理`);
    }
    const result = this.write({
      slug,
      scope,
      type: "daily",
      description: `${date} 工作日志`,
      headline: `${date} 工作日志`,
      body: nextBody,
      actor,
      conversationId: options.conversationId,
      confidence: "high",
      unreviewed: actor !== "user",
      date,
    });
    this.audit(
      this.handleForScope(scope),
      "daily_append",
      result.meta,
      actor,
      options.conversationId,
    );
    return result;
  }

  todayDaily(scope: MemoryScope = "project", now = new Date()): MemoryEntry | null {
    return this.read(`daily-${localDateAt(now, this.rolloverHour)}`, scope);
  }

  quota(): MemoryQuotaItem[] {
    return MEMORY_SCOPES.map((scope) => {
      const count = this.list({
        scope,
        limit: this.maxScopeEntries * 10,
        includeUnreviewed: true,
      }).length;
      return { scope, count, limit: this.maxScopeEntries, exceeded: count > this.maxScopeEntries };
    });
  }

  organizeSuggestions(threshold = 0.55): MemoryOrganizeSuggestion[] {
    const metas = this.list({ limit: this.maxScopeEntries * 2, includeUnreviewed: false }).filter(
      (meta) => meta.type !== "daily",
    );
    const suggestions: MemoryOrganizeSuggestion[] = [];
    for (let i = 0; i < metas.length; i += 1) {
      const left = metas[i];
      if (!left) continue;
      const leftEntry = this.read(left.slug, left.scope);
      if (!leftEntry) continue;
      const leftTokens = tokenizeForSimilarity(
        `${left.headline} ${left.description} ${leftEntry.body}`,
      );
      for (let j = i + 1; j < metas.length; j += 1) {
        const right = metas[j];
        if (!right || left.scope !== right.scope || left.type !== right.type) continue;
        const rightEntry = this.read(right.slug, right.scope);
        if (!rightEntry) continue;
        const similarity = jaccard(
          leftTokens,
          tokenizeForSimilarity(`${right.headline} ${right.description} ${rightEntry.body}`),
        );
        if (similarity >= threshold) suggestions.push({ left, right, similarity });
      }
    }
    return suggestions.sort((a, b) => b.similarity - a.similarity).slice(0, 20);
  }

  wipeAll(scope?: MemoryScope): number {
    this.ensureOpen();
    const targets = scope ? [scope] : (["project", "global"] satisfies MemoryScope[]);
    let removed = 0;
    for (const target of targets) {
      const handle = this.handleForScope(target);
      const hash = target === "project" ? this.workdirHash : "";
      const rows = selectRows(handle, "scope = ? AND workdir_hash = ?", [target, hash]);
      for (const row of rows) {
        if (existsSync(row.filePath)) rmSync(row.filePath);
        removed += 1;
      }
      const directory =
        target === "project"
          ? join(this.projectRoot, "projects", this.workdirHash)
          : join(this.globalRoot, "global");
      if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
      if (target === "global") {
        const dailyDirectory = join(this.globalRoot, "daily");
        if (existsSync(dailyDirectory)) rmSync(dailyDirectory, { recursive: true, force: true });
      }
      handle.db
        .prepare("DELETE FROM memory_meta WHERE scope = ? AND workdir_hash = ?")
        .run(target, hash);
      handle.db
        .prepare("DELETE FROM memory_fts WHERE scope = ? AND workdir_hash = ?")
        .run(target, hash);
      this.audit(
        handle,
        "wipe",
        {
          slug: "*",
          scope: target,
          type: "project",
          description: "",
          headline: "",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          confidence: "unknown",
          unreviewed: false,
          source: { actor: "user" },
          links: [],
          archived: false,
          filePath: "",
          workdirHash: target === "project" ? this.workdirHash : "",
        },
        "user",
        undefined,
        { removed },
      );
    }
    return removed;
  }

  reindex(): void {
    this.ensureIndexesOnly();
    const globalHandle = this.globalIndex as IndexHandle;
    const projectHandle = this.projectIndex as IndexHandle;
    globalHandle.db
      .prepare("DELETE FROM memory_meta WHERE scope = 'global' AND workdir_hash = ''")
      .run();
    globalHandle.db
      .prepare("DELETE FROM memory_fts WHERE scope = 'global' AND workdir_hash = ''")
      .run();
    projectHandle.db
      .prepare("DELETE FROM memory_meta WHERE scope = 'project' AND workdir_hash = ?")
      .run(this.workdirHash);
    projectHandle.db
      .prepare("DELETE FROM memory_fts WHERE scope = 'project' AND workdir_hash = ?")
      .run(this.workdirHash);
    this.reindexDirectory(globalHandle, join(this.globalRoot, "global"));
    this.reindexDirectory(globalHandle, join(this.globalRoot, "daily"));
    this.reindexDirectory(projectHandle, join(this.projectRoot, "projects", this.workdirHash));
  }

  private ensureOpen(): void {
    if (!this.globalIndex || !this.projectIndex) this.open();
  }

  private ensureIndexesOnly(): void {
    if (!this.globalIndex) this.globalIndex = openIndex(this.globalRoot);
    if (!this.projectIndex) this.projectIndex = openIndex(this.projectRoot);
  }

  private handles(): IndexHandle[] {
    this.ensureIndexesOnly();
    return [this.globalIndex as IndexHandle, this.projectIndex as IndexHandle];
  }

  private handleForScope(scope: MemoryScope): IndexHandle {
    this.ensureIndexesOnly();
    return scope === "global"
      ? (this.globalIndex as IndexHandle)
      : (this.projectIndex as IndexHandle);
  }

  private pathFor(scope: MemoryScope, slug: string, type: MemoryType, date?: string): string {
    if (scope === "global") {
      if (type === "daily")
        return join(this.globalRoot, "daily", `${date ?? slug.replace(/^daily-/, "")}.md`);
      return join(this.globalRoot, "global", `${slug}.md`);
    }
    return join(this.projectRoot, "projects", this.workdirHash, `${slug}.md`);
  }

  private requireRead(slug: string, scope?: MemoryScope): MemoryEntry {
    const entry = this.read(slug, scope);
    if (!entry) throw new Error(`记忆不存在: ${slug}`);
    return entry;
  }

  private allRelevantRows(): MetaRow[] {
    this.ensureOpen();
    return [
      ...selectRows(this.globalIndex as IndexHandle, "scope = 'global' AND workdir_hash = ''"),
      ...selectRows(this.projectIndex as IndexHandle, "scope = 'project' AND workdir_hash = ?", [
        this.workdirHash,
      ]),
    ];
  }

  private indexEntry(handle: IndexHandle, parsed: ParsedMemory): void {
    const { meta, body } = parsed;
    const stat = statSync(meta.filePath);
    handle.db
      .prepare(
        `INSERT INTO memory_meta (
           scope, workdir_hash, slug, type, description, headline, date_local,
           confidence, unreviewed, archived, body_hash, file_mtime, file_size,
           created_at, updated_at, source_json, links_json, file_path
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope, workdir_hash, slug) DO UPDATE SET
           type=excluded.type, description=excluded.description, headline=excluded.headline,
           date_local=excluded.date_local, confidence=excluded.confidence,
           unreviewed=excluded.unreviewed, archived=excluded.archived,
           body_hash=excluded.body_hash, file_mtime=excluded.file_mtime,
           file_size=excluded.file_size, updated_at=excluded.updated_at,
           source_json=excluded.source_json, links_json=excluded.links_json,
           file_path=excluded.file_path`,
      )
      .run(
        meta.scope,
        meta.workdirHash,
        meta.slug,
        meta.type,
        meta.description,
        meta.headline,
        meta.date ?? null,
        meta.confidence,
        meta.unreviewed ? 1 : 0,
        meta.archived ? 1 : 0,
        bodyHash(body),
        Math.round(stat.mtimeMs),
        stat.size,
        meta.createdAt,
        meta.updatedAt,
        JSON.stringify(meta.source),
        JSON.stringify(meta.links),
        meta.filePath,
      );
    handle.db
      .prepare("DELETE FROM memory_fts WHERE scope = ? AND workdir_hash = ? AND slug = ?")
      .run(meta.scope, meta.workdirHash, meta.slug);
    handle.db
      .prepare(
        `INSERT INTO memory_fts (slug, scope, workdir_hash, type, description, headline, body)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        meta.slug,
        meta.scope,
        meta.workdirHash,
        meta.type,
        meta.description,
        meta.headline,
        body,
      );
  }

  private audit(
    handle: IndexHandle,
    op: "write" | "update" | "delete" | "accept" | "wipe" | "daily_append",
    meta: MemoryMeta,
    actor: MemoryActor,
    conversationId?: string,
    detail?: Record<string, unknown>,
  ): void {
    handle.db
      .prepare(
        `INSERT INTO memory_audit_log
         (ts, op, scope, workdir_hash, slug, actor, conversation_id, detail_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Date.now(),
        op,
        meta.scope,
        meta.workdirHash,
        meta.slug,
        actor,
        conversationId ?? null,
        detail ? JSON.stringify(detail) : null,
      );
  }

  private reindexDirectory(handle: IndexHandle, root: string): void {
    if (!existsSync(root)) return;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const filePath = join(root, entry.name);
      if (entry.isDirectory()) {
        this.reindexDirectory(handle, filePath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      try {
        const parsed = parseMemoryMarkdown(
          filePath,
          readFileSync(filePath, "utf8"),
          this.workdirHash,
        );
        if (parsed.meta.scope === "global" && handle.root !== this.globalRoot) continue;
        if (parsed.meta.scope === "project" && handle.root !== this.projectRoot) continue;
        parsed.meta.workdirHash = parsed.meta.scope === "project" ? this.workdirHash : "";
        this.indexEntry(handle, parsed);
      } catch {
        // 单个损坏文件不阻断 CLI 启动；用户可修复后再次启动重建索引。
      }
    }
  }
}

export function buildMemoryContext(
  store: MemoryStore,
  query: string,
  options: { limit?: number; maxChars?: number } = {},
): string {
  const limit = options.limit ?? 8;
  const maxChars = options.maxChars ?? 6_000;
  const matches = store.search(query, { limit, includeUnreviewed: false });
  if (matches.length === 0) return "";
  const header = [
    "## 相关长期记忆（自动召回）",
    "以下内容来自用户已审核的本地记忆。它们是参考上下文；若与用户当前指令或项目文件冲突，以当前指令和真实文件为准。",
  ];
  const items: string[] = [];
  // +1 补偿 join("\n") 在条目间插入的换行。
  let used = header.join("\n").length;
  for (const match of matches) {
    const body = match.body.length > 800 ? `${match.body.slice(0, 800)}…` : match.body;
    const item = `\n### [${match.meta.scope}/${match.meta.type}] ${match.meta.headline}（slug: ${match.meta.slug}）\n${match.meta.description}\n${body}`;
    if (used + item.length + 1 > maxChars) continue;
    items.push(item);
    used += item.length + 1;
  }
  if (items.length === 0) return "";
  return [...header, ...items].join("\n");
}
