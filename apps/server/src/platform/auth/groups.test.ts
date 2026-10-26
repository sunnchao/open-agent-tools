import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeGroupList } from "./groups.js";

describe("normalizeGroupList", () => {
  it("drops invalid entries in lenient mode so config saves keep the valid remainder", () => {
    assert.deepEqual(normalizeGroupList(["hr", "*", "", "  ", 42, "hr"], { strict: false }), ["hr"]);
    assert.deepEqual(normalizeGroupList(["a".repeat(61), "hr"], { strict: false }), ["hr"]);
    assert.deepEqual(normalizeGroupList(undefined, { strict: false }), []);
  });

  it("rejects the whole list in strict mode so a malformed assertion is never partially trusted", () => {
    assert.equal(normalizeGroupList(["hr", "*"], { strict: true }), null);
    assert.equal(normalizeGroupList(["hr", 42], { strict: true }), null);
    assert.equal(normalizeGroupList(["a".repeat(61)], { strict: true }), null);
    assert.equal(normalizeGroupList(undefined, { strict: true }), null);
    assert.deepEqual(normalizeGroupList([" hr ", "finance"], { strict: true }), ["hr", "finance"]);
  });

  it("caps both modes at 50 unique groups", () => {
    const many = Array.from({ length: 60 }, (_, i) => `g${i}`);
    assert.equal(normalizeGroupList(many, { strict: false })?.length, 50);
    // 严格模式按原始长度判定，超过上限直接作废而不是截断。
    assert.equal(normalizeGroupList(many, { strict: true }), null);
    assert.equal(normalizeGroupList(many.slice(0, 50), { strict: true })?.length, 50);
  });

  it("deduplicates while preserving first-seen order", () => {
    assert.deepEqual(normalizeGroupList(["b", "a", "b", "c"], { strict: false }), ["b", "a", "c"]);
  });
});
