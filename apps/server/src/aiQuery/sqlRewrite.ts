import { DTMS_TABLE_NAMES, moduleOfTable, type DtmsModule } from "./dtmsCatalog.js";
import { SqlGuardError } from "./sqlGuard.js";
import { PermissionError } from "./permission.js";

const UNION = /\bunion\b/i;
const FROM_JOIN = /\b(?:from|join)\b/i;
const IDENT = /^`?([a-zA-Z_][a-zA-Z0-9_]*)`?/;
const KEYWORDS =
  /^(where|on|join|left|right|inner|cross|outer|natural|group|order|limit|having|union|into|and|or|set|select|from|as|using|straight_join)$/i;

export interface RewrittenSql {
  sql: string;
  params: unknown[];
}

function maskStrings(sql: string): string {
  let out = "";
  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      const quote = c;
      out += " ";
      i += 1;
      while (i < sql.length) {
        out += " ";
        if (sql[i] === quote && sql[i - 1] !== "\\") break;
        i += 1;
      }
    } else {
      out += c;
    }
  }
  return out;
}

interface TableRef {
  start: number;
  end: number;
  table: string;
  alias?: string;
}

function skipWs(text: string, index: number): number {
  let i = index;
  while (i < text.length && /\s/.test(text[i] ?? "")) i += 1;
  return i;
}

function readIdent(text: string, index: number): { name: string; end: number } | null {
  const slice = text.slice(index);
  const match = IDENT.exec(slice);
  if (!match?.[1]) return null;
  return { name: match[1], end: index + match[0].length };
}

/** 从 masked SQL 中收集 FROM/JOIN 表引用（不含子查询）。 */
export function collectTableRefs(sql: string): TableRef[] {
  const masked = maskStrings(sql);
  const refs: TableRef[] = [];
  const re = /\b(?:from|join)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(masked))) {
    const i = skipWs(masked, (match.index ?? 0) + match[0].length);
    if (masked[i] === "(") continue;
    const table = readIdent(masked, i);
    if (!table) continue;
    let end = table.end;
    let alias: string | undefined;
    const afterTable = skipWs(masked, table.end);
    const asToken = readIdent(masked, afterTable);
    if (asToken && asToken.name.toLowerCase() === "as") {
      const aliasTok = readIdent(masked, skipWs(masked, asToken.end));
      if (aliasTok && !KEYWORDS.test(aliasTok.name)) {
        alias = aliasTok.name;
        end = aliasTok.end;
      }
    } else if (asToken && !KEYWORDS.test(asToken.name) && !FROM_JOIN.test(asToken.name)) {
      alias = asToken.name;
      end = asToken.end;
    }
    refs.push({
      start: skipWs(masked, (match.index ?? 0) + match[0].length),
      end,
      table: table.name,
      alias,
    });
  }
  return refs;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

/**
 * 把每个白名单表改写成授权子查询。
 * 改写失败抛错，调用方不得回退执行原文。
 */
export function rewriteSqlWithAuth(
  sql: string,
  industries: string[],
  orgNos: string[],
  allowedModules?: readonly DtmsModule[],
): RewrittenSql {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  const masked = maskStrings(trimmed);
  if (UNION.test(masked)) {
    throw new SqlGuardError("禁止 UNION");
  }
  if (industries.length === 0 || orgNos.length === 0) {
    throw new PermissionError();
  }

  const refs = collectTableRefs(trimmed);
  if (refs.length === 0) {
    throw new SqlGuardError("SQL 未引用任何 DTMS 业务表");
  }

  const allowedTables = new Set(DTMS_TABLE_NAMES.map((n) => n.toLowerCase()));
  const allowedModuleSet =
    allowedModules && allowedModules.length > 0 ? new Set(allowedModules) : null;
  const params: unknown[] = [];
  let out = trimmed;

  for (const ref of [...refs].reverse()) {
    const table = ref.table.toLowerCase();
    if (!allowedTables.has(table)) {
      throw new SqlGuardError(`表不在 DTMS 白名单：${table}`);
    }
    const module = moduleOfTable(table);
    if (allowedModuleSet && module && !allowedModuleSet.has(module)) {
      throw new PermissionError();
    }
    const alias = ref.alias ?? table;
    const inner =
      `SELECT * FROM \`${table}\` WHERE industry IN (${placeholders(industries.length)})` +
      ` AND org_no IN (${placeholders(orgNos.length)})`;
    params.unshift(...industries, ...orgNos);
    const replacement = `(${inner}) AS \`${alias}\``;
    out = out.slice(0, ref.start) + replacement + out.slice(ref.end);
  }

  return { sql: out, params };
}
