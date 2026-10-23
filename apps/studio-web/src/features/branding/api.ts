import { studioFetch } from "../../lib/client.js";
import { parseHttpError as parseError } from "@open-agent-tools/studio-client";

export interface BrandingConfig {
  productName: string;
  shortName: string;
  markText: string;
  logoUrl: string | null;
  primaryColor: string;
  accentColor: string;
  supportUrl: string | null;
  footerText: string;
  partnerCode: string | null;
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

/** 公开品牌信息:员工入口与 Studio 启动都要读,因此走免鉴权端点。 */
export async function fetchPublicBranding(): Promise<BrandingConfig> {
  const response = await studioFetch("/api/branding");
  if (!response.ok) throw new Error(await parseError(response));
  return ((await response.json()) as { branding: BrandingConfig }).branding;
}

export async function fetchBranding(): Promise<BrandingConfig> {
  const response = await studioFetch("/api/admin/branding");
  if (!response.ok) throw new Error(await parseError(response));
  return ((await response.json()) as { branding: BrandingConfig }).branding;
}

export async function saveBranding(input: BrandingConfig): Promise<BrandingConfig> {
  const response = await studioFetch("/api/admin/branding", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await parseError(response));
  return ((await response.json()) as { branding: BrandingConfig }).branding;
}

export async function resetBranding(): Promise<BrandingConfig> {
  const response = await studioFetch("/api/admin/branding", { method: "DELETE" });
  if (!response.ok) throw new Error(await parseError(response));
  return ((await response.json()) as { branding: BrandingConfig }).branding;
}
