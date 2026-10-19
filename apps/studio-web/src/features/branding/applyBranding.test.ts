import { describe, expect, it } from "vitest";
import { applyBranding } from "./applyBranding.js";
import { DEFAULT_BRANDING } from "./api.js";

describe("applyBranding", () => {
  it("writes brand colors and the document title", () => {
    const written: Array<[string, string]> = [];
    const root = {
      style: { setProperty: (name: string, value: string) => written.push([name, value]) },
      title: "",
    };

    applyBranding(
      { ...DEFAULT_BRANDING, primaryColor: "#123456", accentColor: "#abcdef" },
      { root, documentTitleSuffix: "Studio" },
    );

    expect(written).toEqual([
      ["--studio-brand-primary", "#123456"],
      ["--studio-brand-accent", "#abcdef"],
    ]);
    expect(root.title).toBe("Open Agent Tools · Studio");
  });

  it("uses the custom product name in the title", () => {
    const root = { style: { setProperty: () => undefined }, title: "" };
    applyBranding(
      { ...DEFAULT_BRANDING, productName: "私有化助手" },
      { root, documentTitleSuffix: "Knowledge" },
    );
    expect(root.title).toBe("私有化助手 · Knowledge");
  });
});
