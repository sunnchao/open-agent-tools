import { openDb } from "./db.js";

/**
 * 白标配置:私有化交付时替换产品外观与渠道归属,不参与任何业务逻辑。
 * 配置里只有展示字段,没有任何密钥,因此可以公开展示给终端用户。
 */
export interface BrandingConfig {
  productName: string;
  shortName: string;
  /** 侧栏/头部的文字标记,最长 4 个字符(如 "OA")。 */
  markText: string;
  logoUrl: string | null;
  primaryColor: string;
  accentColor: string;
  supportUrl: string | null;
  footerText: string;
  /** 渠道分销码:把该安装实例归属到某个合作伙伴。 */
  partnerCode: string | null;
  /** 是否隐藏原厂品牌字样。 */
  hideVendorBrand: boolean;
}

export const DEFAULT_BRANDING: BrandingConfig = {
  productName: "Open Agent Tools",
  shortName: "Open Agent",
  markText: "OA",
  logoUrl: null,
  primaryColor: "#8fb22e",
  accentColor: "#3d7dcc",
  supportUrl: null,
  footerText: "",
  partnerCode: null,
  hideVendorBrand: false,
};

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const PARTNER_CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

const MAX_LENGTH = {
  productName: 60,
  shortName: 16,
  markText: 4,
  footerText: 120,
  supportUrl: 200,
};

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function safeHttpUrl(value: unknown): string | null {
  const raw = boundedString(value, MAX_LENGTH.supportUrl);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return raw;
  } catch {
    return null;
  }
}

export interface BrandingNormalization {
  branding: BrandingConfig;
  /** 非空表示请求里有非法字段,路由据此返回 400。 */
  errors: string[];
}

/**
 * 规范化白标配置:合法字段取清洗后的值,非法字段保留默认值并记录错误;
 * 未知字段直接忽略,避免任意 JSON 被灌进存储。
 */
export function normalizeBranding(input: unknown): BrandingNormalization {
  const errors: string[] = [];
  const source = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const branding: BrandingConfig = { ...DEFAULT_BRANDING };

  const productName = boundedString(source.productName, MAX_LENGTH.productName);
  if (productName) branding.productName = productName;
  else if (source.productName !== undefined) errors.push("productName 必须是非空字符串");

  const shortName = boundedString(source.shortName, MAX_LENGTH.shortName);
  if (shortName) branding.shortName = shortName;
  else if (source.shortName !== undefined) errors.push("shortName 必须是非空字符串");

  const markText = boundedString(source.markText, MAX_LENGTH.markText);
  if (markText) branding.markText = markText;
  else if (source.markText !== undefined) errors.push("markText 必须是非空字符串(最多 4 字符)");

  if (source.primaryColor !== undefined) {
    const color = boundedString(source.primaryColor, 7);
    if (color && HEX_COLOR.test(color)) branding.primaryColor = color;
    else errors.push("primaryColor 必须是 #RRGGBB 颜色");
  }

  if (source.accentColor !== undefined) {
    const color = boundedString(source.accentColor, 7);
    if (color && HEX_COLOR.test(color)) branding.accentColor = color;
    else errors.push("accentColor 必须是 #RRGGBB 颜色");
  }

  if (source.footerText === null || source.footerText === undefined) {
    branding.footerText = "";
  } else {
    const footer = boundedString(source.footerText, MAX_LENGTH.footerText);
    if (footer) branding.footerText = footer;
    else if (source.footerText !== "") errors.push("footerText 必须是字符串");
  }

  if (source.supportUrl === null || source.supportUrl === undefined || source.supportUrl === "") {
    branding.supportUrl = null;
  } else {
    const url = safeHttpUrl(source.supportUrl);
    if (url) branding.supportUrl = url;
    else errors.push("supportUrl 必须是 http(s) 链接");
  }

  if (source.logoUrl === null || source.logoUrl === undefined || source.logoUrl === "") {
    branding.logoUrl = null;
  } else {
    const url = safeHttpUrl(source.logoUrl);
    if (url) branding.logoUrl = url;
    else errors.push("logoUrl 必须是 http(s) 链接");
  }

  if (
    source.partnerCode === null ||
    source.partnerCode === undefined ||
    source.partnerCode === ""
  ) {
    branding.partnerCode = null;
  } else {
    const code = boundedString(source.partnerCode, 32);
    if (code && PARTNER_CODE.test(code)) branding.partnerCode = code;
    else errors.push("partnerCode 只能包含字母、数字、下划线与连字符(最多 32 位)");
  }

  if (typeof source.hideVendorBrand === "boolean") {
    branding.hideVendorBrand = source.hideVendorBrand;
  } else if (source.hideVendorBrand !== undefined && source.hideVendorBrand !== null) {
    errors.push("hideVendorBrand 必须是布尔值");
  }

  return { branding, errors };
}

/** 合并已存配置与默认值,保证新增字段在老数据上也有值。 */
export function mergeBranding(stored: unknown): BrandingConfig {
  return normalizeBranding(stored).branding;
}

function ensureTable(): void {
  openDb().exec(`
    CREATE TABLE IF NOT EXISTS branding_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      config TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

export function loadBranding(): BrandingConfig {
  ensureTable();
  const row = openDb().prepare("SELECT config FROM branding_config WHERE id = 1").get() as
    { config?: string } | undefined;
  if (!row?.config) return { ...DEFAULT_BRANDING };
  try {
    return mergeBranding(JSON.parse(row.config));
  } catch {
    return { ...DEFAULT_BRANDING };
  }
}

export function saveBranding(next: BrandingConfig): BrandingConfig {
  ensureTable();
  openDb()
    .prepare(
      `INSERT INTO branding_config (id, config, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
    )
    .run(JSON.stringify(next), Date.now());
  return next;
}

export function resetBranding(): BrandingConfig {
  ensureTable();
  openDb().prepare("DELETE FROM branding_config WHERE id = 1").run();
  return { ...DEFAULT_BRANDING };
}
