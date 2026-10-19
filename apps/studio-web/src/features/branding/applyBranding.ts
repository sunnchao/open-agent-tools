import type { BrandingConfig } from "./api.js";

/**
 * 白标落地:把品牌色写成 CSS 变量,并同步文档标题。
 * 只动 `--studio-brand-*` 两个自定义变量,不改主题里其它色板,避免整站配色被带偏。
 */
export interface BrandingTargets {
  root?: { style: { setProperty(name: string, value: string): void }; title: string };
  documentTitleSuffix?: string;
}

export function applyBranding(branding: BrandingConfig, targets: BrandingTargets = {}): void {
  const suffix = targets.documentTitleSuffix ?? "Studio";
  const title = `${branding.productName} · ${suffix}`;
  const root =
    targets.root ??
    (typeof document === "undefined"
      ? undefined
      : (document.documentElement as unknown as BrandingTargets["root"]));

  if (root) {
    root.style.setProperty("--studio-brand-primary", branding.primaryColor);
    root.style.setProperty("--studio-brand-accent", branding.accentColor);
    root.title = title;
  }
  // `documentElement.title` 只是普通属性,真正生效的是 `document.title`。
  if (!targets.root && typeof document !== "undefined") {
    document.title = title;
    document.documentElement.dataset.brand = branding.partnerCode ?? "default";
    document.documentElement.dataset.vendorBrand = branding.hideVendorBrand ? "hidden" : "shown";
  }
}

/** 未加载到配置时的兜底:清掉上一次写入的内联变量,回到默认主题。 */
export function clearBranding(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.style.removeProperty("--studio-brand-primary");
  root.style.removeProperty("--studio-brand-accent");
  delete root.dataset.brand;
  delete root.dataset.vendorBrand;
}
