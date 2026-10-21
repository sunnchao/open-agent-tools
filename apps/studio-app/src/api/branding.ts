// 品牌：RN 侧只做“取值”，落地由主题色 state 完成（无 DOM）。
export type { BrandingConfig } from "./misc";
export {
  DEFAULT_BRANDING,
  fetchBranding,
  fetchPublicBranding,
  resetBranding,
  saveBranding,
} from "./misc";
export function brandTitle(productName: string, suffix = "Studio"): string {
  return `${productName} · ${suffix}`;
}
