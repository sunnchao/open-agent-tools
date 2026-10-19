import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  DEFAULT_BRANDING,
  loadBranding,
  normalizeBranding,
  resetBranding,
  saveBranding,
} from "./branding.js";
import { closeDb } from "./db.js";

let dir = "";

before(() => {
  dir = mkdtempSync(join(tmpdir(), "branding-test-"));
  process.env.SQLITE_PATH = join(dir, "test.sqlite");
  closeDb();
});

after(() => {
  closeDb();
  delete process.env.SQLITE_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe("normalizeBranding", () => {
  it("returns defaults for an empty payload", () => {
    const { branding, errors } = normalizeBranding({});
    assert.deepEqual(errors, []);
    assert.deepEqual(branding, DEFAULT_BRANDING);
  });

  it("applies valid fields and ignores unknown keys", () => {
    const { branding, errors } = normalizeBranding({
      productName: "  某某智能助手  ",
      shortName: "助手",
      markText: "某",
      primaryColor: "#123abc",
      accentColor: "#ABCDEF",
      footerText: "某某科技提供支持",
      partnerCode: "partner-east_1",
      hideVendorBrand: true,
      unknown: "ignored",
    });
    assert.deepEqual(errors, []);
    assert.equal(branding.productName, "某某智能助手");
    assert.equal(branding.shortName, "助手");
    assert.equal(branding.markText, "某");
    assert.equal(branding.primaryColor, "#123abc");
    assert.equal(branding.accentColor, "#ABCDEF");
    assert.equal(branding.footerText, "某某科技提供支持");
    assert.equal(branding.partnerCode, "partner-east_1");
    assert.equal(branding.hideVendorBrand, true);
  });

  it("rejects invalid colors and keeps the default", () => {
    const { branding, errors } = normalizeBranding({ primaryColor: "green" });
    assert.equal(errors.length, 1);
    assert.equal(branding.primaryColor, DEFAULT_BRANDING.primaryColor);
  });

  it("rejects invalid partner codes", () => {
    const { branding, errors } = normalizeBranding({ partnerCode: "带中文的渠道" });
    assert.equal(errors.length, 1);
    assert.equal(branding.partnerCode, null);
  });

  it("rejects non-http support urls", () => {
    const { errors } = normalizeBranding({ supportUrl: "javascript:alert(1)" });
    assert.equal(errors.length, 1);
  });

  it("rejects empty required names", () => {
    const { errors } = normalizeBranding({ productName: "   " });
    assert.equal(errors.length, 1);
  });

  it("treats null optional fields as empty", () => {
    const { branding, errors } = normalizeBranding({
      logoUrl: null,
      supportUrl: null,
      partnerCode: null,
    });
    assert.deepEqual(errors, []);
    assert.equal(branding.logoUrl, null);
    assert.equal(branding.supportUrl, null);
    assert.equal(branding.partnerCode, null);
  });
});

describe("branding store", () => {
  it("returns defaults before anything is saved", () => {
    assert.deepEqual(loadBranding(), DEFAULT_BRANDING);
  });

  it("round-trips a saved configuration", () => {
    const { branding } = normalizeBranding({
      productName: "渠道版助手",
      primaryColor: "#112233",
      partnerCode: "p-1",
    });
    saveBranding(branding);
    const loaded = loadBranding();
    assert.equal(loaded.productName, "渠道版助手");
    assert.equal(loaded.primaryColor, "#112233");
    assert.equal(loaded.partnerCode, "p-1");
    // 未提交的字段仍然有默认值,不会被写空。
    assert.equal(loaded.shortName, DEFAULT_BRANDING.shortName);
  });

  it("resets to defaults", () => {
    assert.deepEqual(resetBranding(), DEFAULT_BRANDING);
    assert.deepEqual(loadBranding(), DEFAULT_BRANDING);
  });
});
