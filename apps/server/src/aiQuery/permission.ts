/**
 * 问数权限上下文：只从登录态 + 中台配置计算，不信任请求体里的 industry/org。
 *
 * 中台接口与 dtms-web 对齐：
 *   GET /oauth2/getUserInfo
 *   GET /oauth2/getSubSysList
 *   GET /oauth2/getUserOrgList
 *   GET /oauth2/menuTree?subSysId=
 */
import type { Request } from "express";
import {
  DTMS_MODULES,
  detectIndustryInText,
  detectModuleInText,
  industryFromSysId,
  isAllowedIndustry,
  moduleFromMenuText,
  type DtmsIndustry,
  type DtmsModule,
} from "./dtmsCatalog.js";
import { logTrace, truncate } from "../trace.js";

export interface PermissionContext {
  userId: string;
  industries: DtmsIndustry[];
  orgNos: string[];
  modules: DtmsModule[];
  /** 请求头当前行业，仅作默认口径，不是授权源。 */
  currentIndustry?: DtmsIndustry;
  /** 请求头当前组织，一期默认按当前组织过滤。 */
  currentOrgNo?: string;
}

export class PermissionError extends Error {
  readonly code = "PERMISSION_DENIED" as const;
  constructor(message = "您暂无该数据范围的查询权限") {
    super(message);
    this.name = "PermissionError";
  }
}

const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, { expiresAt: number; value: PermissionContext }>();

interface OauthUserInfo {
  userId?: string | number;
  username?: string;
}

interface OauthSysItem {
  id?: number | string;
}

interface OauthOrgItem {
  id?: number | string;
  no?: string;
  name?: string;
}

interface OauthMenuItem {
  path?: string;
  name?: string;
  title?: string;
  meta?: { title?: string };
  children?: OauthMenuItem[];
}

function header(req: Request, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function bearerToken(req: Request): string | undefined {
  const auth = header(req, "authorization");
  if (!auth) return undefined;
  return auth.replace(/^Bearer\s+/i, "").trim() || undefined;
}

function oauthBaseUrl(): string {
  return (process.env.DTMS_OAUTH_BASE_URL ?? "").replace(/\/+$/, "");
}

async function oauthGet<T>(
  path: string,
  token: string,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const url = `${oauthBaseUrl()}${path}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(extraHeaders ?? {}),
    },
  });
  if (!resp.ok) {
    throw new PermissionError();
  }
  const json = (await resp.json()) as { code?: number; data?: T } & T;
  if (json && typeof json === "object" && "data" in json && json.data !== undefined) {
    return json.data;
  }
  return json as T;
}

function flattenMenus(
  nodes: OauthMenuItem[] | undefined,
  acc: OauthMenuItem[] = [],
): OauthMenuItem[] {
  if (!nodes) return acc;
  for (const node of nodes) {
    acc.push(node);
    if (node.children?.length) flattenMenus(node.children, acc);
  }
  return acc;
}

function modulesFromMenus(menus: OauthMenuItem[]): DtmsModule[] {
  const set = new Set<DtmsModule>();
  for (const menu of flattenMenus(menus)) {
    const module = moduleFromMenuText(menu.path, menu.name, menu.title, menu.meta?.title);
    if (module) set.add(module);
  }
  return [...set];
}

async function fetchPermissionContext(token: string, req: Request): Promise<PermissionContext> {
  const [user, sysList, orgList] = await Promise.all([
    oauthGet<OauthUserInfo>("/oauth2/getUserInfo", token),
    oauthGet<OauthSysItem[]>("/oauth2/getSubSysList", token),
    oauthGet<OauthOrgItem[]>("/oauth2/getUserOrgList", token),
  ]);
  const userId = String(user?.userId ?? user?.username ?? "");
  if (!userId) throw new PermissionError();

  const industries = (Array.isArray(sysList) ? sysList : [])
    .map((item) => industryFromSysId(item?.id))
    .filter((v): v is DtmsIndustry => Boolean(v));
  const orgNos = (Array.isArray(orgList) ? orgList : [])
    .map((item) => (typeof item?.no === "string" ? item.no.trim() : ""))
    .filter(Boolean);

  const uniqueIndustries = [...new Set(industries)];
  const moduleSet = new Set<DtmsModule>();
  const sysIds = (Array.isArray(sysList) ? sysList : [])
    .map((item) => item?.id)
    .filter((id) => id !== undefined && id !== null);
  await Promise.all(
    sysIds.map(async (id) => {
      try {
        const tree = await oauthGet<OauthMenuItem[]>(`/oauth2/menuTree?subSysId=${id}`, token);
        for (const module of modulesFromMenus(Array.isArray(tree) ? tree : [])) {
          moduleSet.add(module);
        }
      } catch (error) {
        logTrace(
          "ai_query.menu",
          {
            sysId: String(id),
            error: truncate(error instanceof Error ? error.message : String(error), 200),
          },
          "warn",
        );
      }
    }),
  );

  const headerIndustry = industryFromSysId(header(req, "sub-sys-id"));
  const headerOrgNo = header(req, "org-no");
  return {
    userId,
    industries: uniqueIndustries,
    orgNos: [...new Set(orgNos)],
    modules: moduleSet.size > 0 ? [...moduleSet] : [...DTMS_MODULES],
    currentIndustry:
      headerIndustry && uniqueIndustries.includes(headerIndustry) ? headerIndustry : undefined,
    currentOrgNo: headerOrgNo && orgNos.includes(headerOrgNo) ? headerOrgNo : undefined,
  };
}

/** 开发兜底：未配 DTMS_OAUTH_BASE_URL 时用请求头拼最小权限，便于单测/本地联调。 */
function fallbackFromHeaders(req: Request): PermissionContext {
  const userId = header(req, "x-user-id") ?? "anonymous";
  const named = (header(req, "x-ai-industries") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is DtmsIndustry => isAllowedIndustry(s));
  const orgNos = (header(req, "x-ai-org-nos") ?? header(req, "org-no") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const modules = (header(req, "x-ai-modules") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is DtmsModule => (DTMS_MODULES as readonly string[]).includes(s));
  const currentIndustry = industryFromSysId(header(req, "sub-sys-id"));
  const currentOrgNo = header(req, "org-no");
  return {
    userId,
    industries: named.length > 0 ? named : currentIndustry ? [currentIndustry] : [],
    orgNos,
    modules: modules.length > 0 ? modules : [...DTMS_MODULES],
    currentIndustry,
    currentOrgNo,
  };
}

export async function resolvePermissionContext(req: Request): Promise<PermissionContext> {
  const token = bearerToken(req);
  if (!oauthBaseUrl()) {
    const ctx = fallbackFromHeaders(req);
    if (ctx.industries.length === 0 || ctx.orgNos.length === 0) throw new PermissionError();
    return ctx;
  }
  if (!token) throw new PermissionError();
  const cached = cache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      ...cached.value,
      currentIndustry: industryFromSysId(header(req, "sub-sys-id")) ?? cached.value.currentIndustry,
      currentOrgNo: header(req, "org-no") ?? cached.value.currentOrgNo,
    };
  }
  const value = await fetchPermissionContext(token, req);
  if (value.industries.length === 0 || value.orgNos.length === 0) throw new PermissionError();
  cache.set(token, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

export function __resetPermissionCache(): void {
  cache.clear();
}

/**
 * 有效行级范围：一期默认当前组织（与列表页一致）；无当前组织则用全部授权组织。
 * 行业：当前行业若在授权内则收窄，否则用全部授权行业。
 */
export function effectiveRowScope(ctx: PermissionContext): {
  industries: DtmsIndustry[];
  orgNos: string[];
} {
  const industries =
    ctx.currentIndustry && ctx.industries.includes(ctx.currentIndustry)
      ? [ctx.currentIndustry]
      : ctx.industries;
  const orgNos =
    ctx.currentOrgNo && ctx.orgNos.includes(ctx.currentOrgNo) ? [ctx.currentOrgNo] : ctx.orgNos;
  return { industries, orgNos };
}

export function assertQueryInScope(
  question: string,
  pageContext: string | undefined,
  ctx: PermissionContext,
): { module?: DtmsModule; industry?: DtmsIndustry } {
  const askedIndustry = detectIndustryInText(question) ?? detectIndustryInText(pageContext ?? "");
  if (askedIndustry && !ctx.industries.includes(askedIndustry)) {
    throw new PermissionError();
  }
  const askedModule = detectModuleInText(question) ?? detectModuleInText(pageContext ?? "");
  if (askedModule && !ctx.modules.includes(askedModule)) {
    throw new PermissionError();
  }
  return { module: askedModule, industry: askedIndustry };
}
